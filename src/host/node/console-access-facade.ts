import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";
import {
	DEVICE_GRANT_VERSION,
	deviceRequestScope,
	isSafeDeviceIdentifier,
	sha256Hex,
	type CanonicalDeviceRequestInput,
	type DeviceGrantDescriptor,
	type DeviceGrantEnrollmentRequest,
	canonicalDeviceRequest,
} from "../../console/device-grants.js";
import { DeviceGrantStore, DeviceGrantStoreError } from "./device-grant-store.js";
import {
	parseOwnerPushAuthoritativeEvent,
	parseOwnerPushContext,
	type OwnerPushContext,
} from "../../console/owner-push.js";
import { OwnerPushRuntime, ownerPushError } from "./owner-push-runtime.js";
import {
	isVoiceReceiptAuthorityKey,
	parseVoiceReceiptAuthorityKey,
	voiceReceiptAgentCorrelation,
	voiceReceiptAuthorityProof,
	voiceReceiptCorrelation,
} from "../../console/voice-receipts.js";

const EMPTY_SHA256 = sha256Hex(new Uint8Array());
const DEFAULT_MAXIMUM_BODY_BYTES = 2_700_000;

export interface ConsoleAccessFacadeOptions {
	ownerToken: string;
	upstreamBaseURL: URL;
	upstreamAuthorization?: string;
	allowedAgentRoutes: string[];
	grantStore: DeviceGrantStore;
	/** Optional complete owner-push authority. Omission keeps the capability unavailable. */
	ownerPush?: OwnerPushRuntime;
	/** Independent server-producer bearer; never forwarded to or exposed through the model runtime. */
	ownerPushProducerToken?: string;
	/** Shared 32-byte secret for authenticated facade-to-Gateway receipt claims. */
	voiceReceiptAuthorityKey?: Uint8Array;
	maximumBodyBytes?: number;
	fetchImplementation?: typeof fetch;
	runtimeIdentity?: string;
	sourceIdentity?: string;
	onRequestDiagnostic?: (diagnostic: ConsoleAccessRequestDiagnostic) => void;
	onVoiceTimingDiagnostic?: (diagnostic: ConsoleAccessVoiceTimingDiagnostic) => void;
	timingNow?: () => number;
}

interface VerifiedVoiceReceiptAuthority {
	agentCorrelation: string;
	requestCorrelation: string;
	proof: string;
}

export interface ConsoleAccessRequestDiagnostic {
	outcome: "rejected";
	http_status: number;
	response_category: string;
	request_correlation: string;
	session_correlation?: string;
	runtime_identity: string;
	source_identity: string;
}

export type ConsoleAccessVoiceTimingStage =
	| "request_body_received"
	| "authorization_verified"
	| "upstream_request_started"
	| "upstream_response_received"
	| "response_completed";

export interface ConsoleAccessVoiceTimingDiagnostic {
	version: "computer.voice-facade-timing.v1";
	stage: ConsoleAccessVoiceTimingStage;
	ordinal: number;
	elapsed_milliseconds: number;
	request_correlation: string;
	session_correlation: string;
	http_status?: number;
	runtime_identity: string;
	source_identity: string;
}

interface ConsoleAccessVoiceTimingContext {
	startedAt: number;
	bodyReceivedElapsed: number;
	requestCorrelation: string;
	sessionCorrelation: string;
	nextOrdinal: number;
}

/**
 * Narrow authentication facade for a standalone console gateway.
 *
 * Owner bearer authorization may enroll or revoke a device. A device proves a
 * scoped P-256 key grant per request. All inbound authority is stripped before
 * the request reaches the loopback runtime.
 */
export class ConsoleAccessFacade {
	private server: Server | null = null;
	private readonly allowedAgentRoutes: Set<string>;
	private readonly maximumBodyBytes: number;
	private readonly fetchImplementation: typeof fetch;
	private readonly ownerPushProducerToken?: string;
	private readonly voiceReceiptAuthorityKey?: Uint8Array;
	private readonly timingNow: () => number;

	constructor(private readonly options: ConsoleAccessFacadeOptions) {
		if (options.ownerToken.trim().length < 24) throw new Error("Owner token is missing or too short");
		if (!isLoopbackURL(options.upstreamBaseURL)) throw new Error("Console facade upstream must be loopback");
		this.allowedAgentRoutes = new Set(options.allowedAgentRoutes);
		if (this.allowedAgentRoutes.size === 0 || [...this.allowedAgentRoutes].some((route) => !isSafeDeviceIdentifier(route))) {
			throw new Error("Console facade requires safe explicit agent routes");
		}
		this.maximumBodyBytes = options.maximumBodyBytes ?? DEFAULT_MAXIMUM_BODY_BYTES;
		if (!Number.isSafeInteger(this.maximumBodyBytes) || this.maximumBodyBytes < 1) {
			throw new Error("Console facade requires a positive body limit");
		}
		this.fetchImplementation = options.fetchImplementation ?? fetch;
		this.timingNow = options.timingNow ?? (() => performance.now());
		const producerToken = options.ownerPushProducerToken?.trim();
		if (producerToken && Buffer.byteLength(producerToken, "utf8") < 32) {
			throw new Error("Owner push producer token must be at least 32 bytes");
		}
		if (producerToken === options.ownerToken) {
			throw new Error("Owner push producer authority must be independent from owner access");
		}
		if (Boolean(options.ownerPush) !== Boolean(producerToken)
			|| (options.ownerPush && !options.ownerPush.available)) {
			throw new Error("Owner push requires a runtime, transport, and independent producer authority");
		}
		this.ownerPushProducerToken = producerToken;
		const authorityKey = options.voiceReceiptAuthorityKey
			?? parseVoiceReceiptAuthorityKey(process.env.TROUBLEMAKER_VOICE_RECEIPT_AUTHORITY_KEY);
		if (authorityKey && !isVoiceReceiptAuthorityKey(authorityKey)) {
			throw new Error("Console facade voice receipt authority key must contain exactly 32 bytes");
		}
		this.voiceReceiptAuthorityKey = authorityKey ? new Uint8Array(authorityKey) : undefined;
	}

	async start(port: number, host = "127.0.0.1"): Promise<number> {
		if (this.server) throw new Error("Console facade is already running");
		if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Console facade must bind to loopback");
		this.server = createServer((req, res) => {
			void this.handle(req, res).catch(() => this.sendError(res, 500, "request_failed"));
		});
		this.server.requestTimeout = 0;
		this.server.headersTimeout = 30_000;
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(port, host, () => {
				this.server!.removeListener("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Console facade did not bind a TCP port");
		return address.port;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = null;
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const requestStartedAt = this.timingNow();
		const url = new URL(req.url || "/", "http://localhost");
		if (url.pathname === "/api/v2/owner-notification-events") {
			await this.handleOwnerPushAuthoritativeEvent(req, res);
			return;
		}
		const ownerPushAcknowledgmentRoute = matchOwnerPushAcknowledgmentRoute(url.pathname);
		if (ownerPushAcknowledgmentRoute) {
			await this.handleOwnerPushAcknowledgment(req, res, ownerPushAcknowledgmentRoute);
			return;
		}
		const ownerPushDeviceRoute = matchOwnerPushDeviceRoute(url.pathname);
		if (ownerPushDeviceRoute) {
			await this.handleOwnerPushDevice(req, res, ownerPushDeviceRoute);
			return;
		}
		const grantRoute = matchGrantRoute(url.pathname);
		if (grantRoute) {
			if (!this.allowedAgentRoutes.has(grantRoute.routeAgentId)) {
				this.sendError(res, 404, "not_found");
				return;
			}
			if (!this.ownerAuthorized(req.headers.authorization)) {
				this.sendError(res, 401, "unauthorized");
				return;
			}
			if (req.method === "POST" && !grantRoute.grantId) {
				await this.issueGrant(req, res, grantRoute.routeAgentId);
				return;
			}
			if (req.method === "DELETE" && grantRoute.grantId) {
				const revoked = this.options.grantStore.revoke(grantRoute.routeAgentId, grantRoute.grantId);
				if (!revoked) this.sendError(res, 404, "grant_not_found");
				else this.sendJSON(res, 200, { revoked: true, grant_id: grantRoute.grantId });
				return;
			}
			this.sendError(res, 405, "method_not_allowed");
			return;
		}

		const routeAgentId = extractAgentRoute(url.pathname);
		const scope = deviceRequestScope(req.method || "GET", url.pathname);
		if (!routeAgentId || !scope || !this.allowedAgentRoutes.has(routeAgentId)) {
			this.sendError(res, 404, "not_found");
			return;
		}

		let body: Buffer;
		try {
			body = await readBoundedBody(req, this.maximumBodyBytes);
		} catch (error) {
			if (error instanceof BoundedBodyError) {
				this.sendError(res, error.status, error.code);
				return;
			}
			throw error;
		}
		const bodyReceivedElapsed = this.elapsedMilliseconds(requestStartedAt);
		let requestedOwnerContext: OwnerPushContext | undefined;
		try {
			requestedOwnerContext = extractOwnerContextRequest(req.method, url, body);
		} catch {
			this.sendError(res, 400, "invalid_owner_context");
			return;
		}
		if (this.ownerAuthorized(req.headers.authorization)) {
			if (scope === "voice_receipts") {
				this.sendError(res, 403, "device_grant_required");
				return;
			}
			let verifiedOwnerContext: OwnerPushContext | undefined;
			if (requestedOwnerContext) {
				if (!this.options.ownerPush) {
					this.sendError(res, 503, "owner_context_authority_unavailable");
					return;
				}
				try {
					const subjectAgentId = await this.readUpstreamStatus(routeAgentId);
					verifiedOwnerContext = await this.options.ownerPush.authorizeContext(
						requestedOwnerContext,
						routeAgentId,
						subjectAgentId,
						requestedOwnerContext.relationship_id,
					);
				} catch (error) {
					const known = ownerPushError(error);
					this.sendError(res, known?.status ?? 502, known?.code ?? "owner_context_verification_failed");
					return;
				}
			}
			this.forward(req, res, url, body, undefined, undefined, undefined, undefined, verifiedOwnerContext);
			return;
		}

		const authorization = parseDeviceAuthorization(req.headers.authorization);
		if (!authorization) {
			this.sendError(res, 401, "unauthorized");
			return;
		}
		const timestamp = singleHeader(req, "x-troublemaker-device-timestamp");
		const nonce = singleHeader(req, "x-troublemaker-device-nonce");
		const suppliedDigest = singleHeader(req, "x-troublemaker-device-body-sha256").toLowerCase();
		const signature = singleHeader(req, "x-troublemaker-device-signature");
		const subjectAgentId = singleHeader(req, "x-troublemaker-device-subject");
		const actualDigest = sha256Hex(body);
		if (!/^[a-f0-9]{64}$/.test(suppliedDigest) || suppliedDigest !== actualDigest) {
			this.sendError(res, 401, "body_digest_mismatch");
			return;
		}
		const canonical: CanonicalDeviceRequestInput = {
			method: req.method || "GET",
			pathAndQuery: `${url.pathname}${url.search}`,
			timestamp,
			nonce,
			contentType: String(req.headers["content-type"] || ""),
			bodyDigest: suppliedDigest || EMPTY_SHA256,
			subjectAgentId,
		};
		let verifiedGrant: DeviceGrantDescriptor;
		try {
			verifiedGrant = this.options.grantStore.verifyRequest(
				authorization.grantId,
				scope,
				routeAgentId,
				canonical,
				signature,
			);
		} catch (error) {
			if (error instanceof DeviceGrantStoreError) {
				this.observeRequestRejection(error, nonce, url, body);
				this.sendError(res, error.status, error.code);
				return;
			}
			throw error;
		}
		let verifiedOwnerContext: OwnerPushContext | undefined;
		if (requestedOwnerContext) {
			if (!this.options.ownerPush) {
				this.sendError(res, 503, "owner_context_authority_unavailable");
				return;
			}
			try {
				verifiedOwnerContext = await this.options.ownerPush.authorizeContext(
					requestedOwnerContext,
					verifiedGrant.route_agent_id,
					verifiedGrant.subject_agent_id,
					verifiedGrant.binding_id,
				);
			} catch (error) {
				const known = ownerPushError(error);
				this.sendError(res, known?.status ?? 502, known?.code ?? "owner_context_verification_failed");
				return;
			}
		}
		if (scope === "voice_receipts" && body.byteLength !== 0) {
			this.sendError(res, 400, "receipt_body_not_allowed");
			return;
		}
		const receiptBoundary = scope === "voice_receipts"
			|| isVoiceReceiptMutation(req.method, url.pathname);
		if (receiptBoundary && !this.voiceReceiptAuthorityKey) {
			this.sendError(res, 503, "receipt_authority_unavailable");
			return;
		}
		let voiceReceiptAuthority: VerifiedVoiceReceiptAuthority | undefined;
		if (receiptBoundary && this.voiceReceiptAuthorityKey) {
			const agentCorrelation = voiceReceiptAgentCorrelation(
				verifiedGrant.route_agent_id,
				verifiedGrant.subject_agent_id,
			);
			const requestCorrelation = voiceReceiptCorrelation(nonce);
			voiceReceiptAuthority = {
				agentCorrelation,
				requestCorrelation,
				proof: voiceReceiptAuthorityProof(this.voiceReceiptAuthorityKey, {
					method: req.method === "GET" ? "GET" : "POST",
					path_and_query: `${url.pathname}${url.search}`,
					body_digest: actualDigest,
					agent_correlation: agentCorrelation,
					request_correlation: requestCorrelation,
				}),
			};
		}
		let voiceTiming: ConsoleAccessVoiceTimingContext | undefined;
		if (isVoiceRecordingMutation(req.method, url.pathname)) {
			const sessionCorrelation = voiceSessionCorrelation(url, body);
			if (sessionCorrelation) {
				voiceTiming = {
					startedAt: requestStartedAt,
					bodyReceivedElapsed,
					requestCorrelation: hashDiagnosticCorrelation(nonce),
					sessionCorrelation,
					nextOrdinal: 1,
				};
				this.observeVoiceTiming(voiceTiming, "request_body_received", undefined, bodyReceivedElapsed);
				this.observeVoiceTiming(voiceTiming, "authorization_verified");
			}
		}
		this.forward(
			req,
			res,
			url,
			body,
			verifiedGrant.surface,
			verifiedGrant.binding_id,
			voiceReceiptAuthority,
			voiceTiming,
			verifiedOwnerContext,
		);
	}

	private observeRequestRejection(
		error: DeviceGrantStoreError,
		nonce: string,
		url: URL,
		body: Buffer,
	): void {
		const sessionCorrelation = voiceSessionCorrelation(url, body);
		const diagnostic: ConsoleAccessRequestDiagnostic = {
			outcome: "rejected",
			http_status: error.status,
			response_category: safeDiagnosticIdentity(error.code),
			request_correlation: hashDiagnosticCorrelation(nonce || `${url.pathname}${url.search}`),
			...(sessionCorrelation ? { session_correlation: sessionCorrelation } : {}),
			runtime_identity: safeDiagnosticIdentity(this.options.runtimeIdentity),
			source_identity: safeDiagnosticIdentity(this.options.sourceIdentity),
		};
		try { this.options.onRequestDiagnostic?.(diagnostic); }
		catch { /* diagnostics must never change authorization or request behavior */ }
	}

	private async handleOwnerPushAuthoritativeEvent(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		if (req.method !== "POST") {
			this.sendError(res, 405, "method_not_allowed");
			return;
		}
		if (!this.producerAuthorized(req.headers.authorization)) {
			this.sendError(res, 401, "unauthorized");
			return;
		}
		if (!this.options.ownerPush?.available) {
			this.sendError(res, 503, "owner_push_unavailable");
			return;
		}
		try {
			const body = await readBoundedBody(req, 32_768);
			let event: unknown;
			try { event = JSON.parse(body.toString("utf8")); }
			catch {
				this.sendError(res, 400, "invalid_owner_push_authoritative_event");
				return;
			}
			const authoritative = parseOwnerPushAuthoritativeEvent(event);
			if (!authoritative) {
				this.sendError(res, 400, "invalid_owner_push_authoritative_event");
				return;
			}
			if (!this.allowedAgentRoutes.has(authoritative.envelope.route_agent_id)) {
				this.sendError(res, 404, "not_found");
				return;
			}
			const subjectAgentId = await this.readUpstreamStatus(authoritative.envelope.route_agent_id);
			if (subjectAgentId !== authoritative.envelope.subject_agent_id) {
				this.sendError(res, 409, "owner_push_agent_mismatch");
				return;
			}
			const result = await this.options.ownerPush.dispatchAuthoritative(authoritative);
			this.sendJSON(res, 200, result);
		} catch (error) {
			if (error instanceof BoundedBodyError) {
				this.sendError(res, error.status, error.code);
				return;
			}
			const known = ownerPushError(error);
			this.sendError(res, known?.status ?? 502, known?.code ?? "owner_push_dispatch_failed");
		}
	}

	private async handleOwnerPushAcknowledgment(
		req: IncomingMessage,
		res: ServerResponse,
		route: OwnerPushAcknowledgmentRoute,
	): Promise<void> {
		if (!this.allowedAgentRoutes.has(route.routeAgentId)) {
			this.sendError(res, 404, "not_found");
			return;
		}
		if (!this.ownerAuthorized(req.headers.authorization)) {
			this.sendError(res, 401, "unauthorized");
			return;
		}
		if (!this.options.ownerPush?.available) {
			this.sendError(res, 503, "owner_push_unavailable");
			return;
		}
		if (req.method !== "POST") {
			this.sendError(res, 405, "method_not_allowed");
			return;
		}
		try {
			const body = await readBoundedBody(req, 16_384);
			let acknowledgment: unknown;
			try { acknowledgment = JSON.parse(body.toString("utf8")); }
			catch {
				this.sendError(res, 400, "invalid_owner_push_acknowledgment");
				return;
			}
			const subjectAgentId = await this.readUpstreamStatus(route.routeAgentId);
			const result = this.options.ownerPush.acknowledge(
				acknowledgment,
				route.notificationId,
				route.routeAgentId,
				subjectAgentId,
			);
			this.sendJSON(res, 200, result);
		} catch (error) {
			if (error instanceof BoundedBodyError) {
				this.sendError(res, error.status, error.code);
				return;
			}
			const known = ownerPushError(error);
			this.sendError(res, known?.status ?? 502, known?.code ?? "agent_verification_failed");
		}
	}

	private async handleOwnerPushDevice(
		req: IncomingMessage,
		res: ServerResponse,
		route: OwnerPushDeviceRoute,
	): Promise<void> {
		if (!this.allowedAgentRoutes.has(route.routeAgentId)) {
			this.sendError(res, 404, "not_found");
			return;
		}
		if (!this.ownerAuthorized(req.headers.authorization)) {
			this.sendError(res, 401, "unauthorized");
			return;
		}
		if (!this.options.ownerPush?.available) {
			this.sendError(res, 503, "owner_push_unavailable");
			return;
		}
		try {
			const subjectAgentId = await this.readUpstreamStatus(route.routeAgentId);
			if (req.method === "POST" && !route.installationId) {
				const body = await readBoundedBody(req, 32_768);
				let registration: unknown;
				try { registration = JSON.parse(body.toString("utf8")); }
				catch {
					this.sendError(res, 400, "invalid_owner_push_registration");
					return;
				}
				const result = this.options.ownerPush.register(
					registration,
					route.routeAgentId,
					subjectAgentId,
				);
				this.sendJSON(res, result.disposition === "accepted" ? 201 : 200, result);
				return;
			}
			if (req.method === "DELETE" && route.installationId) {
				const removed = this.options.ownerPush.revoke(
					route.routeAgentId,
					subjectAgentId,
					route.installationId,
				);
				this.sendJSON(res, 200, {
					revoked: removed > 0,
					installation_id: route.installationId,
				});
				return;
			}
			this.sendError(res, 405, "method_not_allowed");
		} catch (error) {
			if (error instanceof BoundedBodyError) {
				this.sendError(res, error.status, error.code);
				return;
			}
			const known = ownerPushError(error);
			if (known) {
				this.sendError(res, known.status, known.code);
				return;
			}
			this.sendError(res, 502, "agent_verification_failed");
		}
	}

	private async issueGrant(req: IncomingMessage, res: ServerResponse, routeAgentId: string): Promise<void> {
		let enrollment: DeviceGrantEnrollmentRequest;
		try {
			const body = await readBoundedBody(req, 32_768);
			enrollment = JSON.parse(body.toString("utf8")) as DeviceGrantEnrollmentRequest;
		} catch (error) {
			if (error instanceof BoundedBodyError) this.sendError(res, error.status, error.code);
			else this.sendError(res, 400, "invalid_enrollment");
			return;
		}
		try {
			const status = await this.readUpstreamStatus(routeAgentId);
			if (status !== enrollment.subject_agent_id) {
				this.sendError(res, 409, "agent_identity_mismatch");
				return;
			}
			const descriptor = this.options.grantStore.issue(routeAgentId, enrollment);
			this.sendJSON(res, 201, descriptor);
		} catch (error) {
			if (error instanceof DeviceGrantStoreError) {
				this.sendError(res, error.status, error.code);
				return;
			}
			this.sendError(res, 502, "agent_verification_failed");
		}
	}

	private async readUpstreamStatus(routeAgentId: string): Promise<string> {
		const url = new URL(`/api/v2/agents/${encodeURIComponent(routeAgentId)}/status`, this.options.upstreamBaseURL);
		const headers = new Headers();
		if (this.options.upstreamAuthorization) headers.set("Authorization", this.options.upstreamAuthorization);
		const response = await this.fetchImplementation(url, { headers, redirect: "error" });
		if (!response.ok) throw new Error("Upstream status unavailable");
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > 65_536) throw new Error("Upstream status response is too large");
		const payload = JSON.parse(new TextDecoder().decode(bytes)) as { agent_id?: unknown; agentId?: unknown };
		const identity = payload.agent_id ?? payload.agentId;
		if (!isSafeDeviceIdentifier(identity)) throw new Error("Upstream status identity is invalid");
		return identity;
	}

	private elapsedMilliseconds(startedAt: number): number {
		return Math.max(0, Math.floor(this.timingNow() - startedAt));
	}

	private observeVoiceTiming(
		context: ConsoleAccessVoiceTimingContext,
		stage: ConsoleAccessVoiceTimingStage,
		httpStatus?: number,
		elapsedOverride?: number,
	): void {
		const diagnostic: ConsoleAccessVoiceTimingDiagnostic = {
			version: "computer.voice-facade-timing.v1",
			stage,
			ordinal: context.nextOrdinal++,
			elapsed_milliseconds: elapsedOverride ?? this.elapsedMilliseconds(context.startedAt),
			request_correlation: context.requestCorrelation,
			session_correlation: context.sessionCorrelation,
			...(httpStatus ? { http_status: httpStatus } : {}),
			runtime_identity: safeDiagnosticIdentity(this.options.runtimeIdentity),
			source_identity: safeDiagnosticIdentity(this.options.sourceIdentity),
		};
		try { this.options.onVoiceTimingDiagnostic?.(diagnostic); }
		catch { /* diagnostics never change authorization or forwarding */ }
	}

	private forward(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		body: Buffer,
		verifiedSurface?: string,
		verifiedRelationshipId?: string,
		voiceReceiptAuthority?: VerifiedVoiceReceiptAuthority,
		voiceTiming?: ConsoleAccessVoiceTimingContext,
		verifiedOwnerContext?: OwnerPushContext,
	): void {
		const upstreamURL = new URL(`${url.pathname}${url.search}`, this.options.upstreamBaseURL);
		const headers = sanitizedForwardHeaders(req.headers);
		if (this.options.upstreamAuthorization) headers.authorization = this.options.upstreamAuthorization;
		if (verifiedSurface) headers["x-troublemaker-verified-device-surface"] = verifiedSurface;
		if (verifiedRelationshipId) {
			headers["x-troublemaker-verified-device-relationship"] = verifiedRelationshipId;
		}
		if (voiceReceiptAuthority) {
			headers["x-troublemaker-verified-voice-agent-correlation"] = voiceReceiptAuthority.agentCorrelation;
			headers["x-troublemaker-verified-voice-request-correlation"] = voiceReceiptAuthority.requestCorrelation;
			headers["x-troublemaker-internal-voice-receipt-proof"] = voiceReceiptAuthority.proof;
		}
		if (verifiedOwnerContext) {
			headers["x-troublemaker-verified-owner-context"] = Buffer.from(
				JSON.stringify(verifiedOwnerContext),
				"utf8",
			).toString("base64url");
		}
		headers.host = upstreamURL.host;
		headers["content-length"] = String(body.byteLength);
		if (voiceTiming) this.observeVoiceTiming(voiceTiming, "upstream_request_started");
		const request = upstreamURL.protocol === "https:" ? httpsRequest : httpRequest;
		const upstream = request(upstreamURL, {
			method: req.method,
			headers,
		}, (upstreamResponse) => {
			const upstreamStatus = upstreamResponse.statusCode || 502;
			if (voiceTiming) this.observeVoiceTiming(
				voiceTiming,
				"upstream_response_received",
				upstreamStatus,
			);
			const responseHeaders = { ...upstreamResponse.headers };
			delete responseHeaders["set-cookie"];
			delete responseHeaders["set-cookie2"];
			responseHeaders["cache-control"] = "no-cache, no-store, no-transform";
			if (String(responseHeaders["content-type"] || "").startsWith("text/event-stream")) {
				delete responseHeaders["content-length"];
				responseHeaders["x-accel-buffering"] = "no";
			}
			res.writeHead(upstreamStatus, responseHeaders);
			upstreamResponse.once("end", () => {
				if (voiceTiming) this.observeVoiceTiming(
					voiceTiming,
					"response_completed",
					upstreamStatus,
				);
			});
			upstreamResponse.pipe(res);
		});
		upstream.on("error", () => {
			if (!res.headersSent) this.sendError(res, 502, "upstream_unavailable");
			else res.end();
		});
		if (body.byteLength > 0) upstream.write(body);
		upstream.end();
	}

	private ownerAuthorized(header: string | string[] | undefined): boolean {
		return bearerAuthorized(header, this.options.ownerToken);
	}

	private producerAuthorized(header: string | string[] | undefined): boolean {
		return Boolean(this.ownerPushProducerToken)
			&& bearerAuthorized(header, this.ownerPushProducerToken!);
	}

	private sendJSON(res: ServerResponse, status: number, payload: unknown): void {
		if (res.writableEnded) return;
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(JSON.stringify(payload));
	}

	private sendError(res: ServerResponse, status: number, code: string): void {
		this.sendJSON(res, status, { error: code });
	}
}

interface OwnerPushAcknowledgmentRoute {
	routeAgentId: string;
	notificationId: string;
}

function matchOwnerPushAcknowledgmentRoute(pathname: string): OwnerPushAcknowledgmentRoute | null {
	const match = pathname.match(
		/^\/api\/v2\/agents\/([^/]+)\/owner-notifications\/([^/]+)\/acknowledgments$/,
	);
	if (!match) return null;
	try {
		const routeAgentId = decodeURIComponent(match[1]);
		const notificationId = decodeURIComponent(match[2]);
		if (!isSafeDeviceIdentifier(routeAgentId) || !isSafeDeviceIdentifier(notificationId)) return null;
		return { routeAgentId, notificationId };
	} catch {
		return null;
	}
}

interface OwnerPushDeviceRoute {
	routeAgentId: string;
	installationId?: string;
}

function matchOwnerPushDeviceRoute(pathname: string): OwnerPushDeviceRoute | null {
	const match = pathname.match(
		/^\/api\/v2\/agents\/([^/]+)\/owner-notification-devices(?:\/([^/]+))?$/,
	);
	if (!match) return null;
	try {
		const routeAgentId = decodeURIComponent(match[1]);
		const installationId = match[2] ? decodeURIComponent(match[2]) : undefined;
		if (!isSafeDeviceIdentifier(routeAgentId)
			|| (installationId && !isSafeDeviceIdentifier(installationId))) return null;
		return { routeAgentId, ...(installationId ? { installationId } : {}) };
	} catch {
		return null;
	}
}

function extractOwnerContextRequest(
	method: string | undefined,
	url: URL,
	body: Buffer,
): OwnerPushContext | undefined {
	const normalizedMethod = (method || "GET").toUpperCase();
	const queryContextKeys = [...url.searchParams.keys()].filter((key) =>
		key === "context_kind"
		|| key === "context_id"
		|| key === "relationship_id"
		|| key === "anchor_id"
		|| key.startsWith("context_"));
	if (queryContextKeys.length > 0) {
		if (normalizedMethod !== "GET"
			|| !/^\/api\/v2\/agents\/[^/]+\/(?:events|live)$/.test(url.pathname)) {
			throw new Error("invalid_owner_context");
		}
		const allowed = ["context_kind", "context_id", "relationship_id", "anchor_id"];
		if (queryContextKeys.some((key) => !allowed.includes(key))
			|| allowed.some((key) => url.searchParams.getAll(key).length > 1)) {
			throw new Error("invalid_owner_context");
		}
		const context = parseOwnerPushContext({
			kind: url.searchParams.get("context_kind"),
			context_id: url.searchParams.get("context_id"),
			relationship_id: url.searchParams.get("relationship_id"),
			...(url.searchParams.has("anchor_id")
				? { anchor_id: url.searchParams.get("anchor_id") }
				: {}),
		});
		if (!context) throw new Error("invalid_owner_context");
		return context;
	}

	if (normalizedMethod !== "POST"
		|| !/^\/api\/v2\/agents\/[^/]+\/messages(?:\/stop)?$/.test(url.pathname)) return undefined;
	let parsed: unknown;
	try { parsed = body.byteLength > 0 ? JSON.parse(body.toString("utf8")) : {}; }
	catch { return undefined; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.ownerContext !== undefined && record.owner_context !== undefined) {
		throw new Error("invalid_owner_context");
	}
	const value = record.ownerContext ?? record.owner_context;
	if (value === undefined) return undefined;
	const context = parseOwnerPushContext(value);
	if (!context) throw new Error("invalid_owner_context");
	return context;
}

interface GrantRoute {
	routeAgentId: string;
	grantId?: string;
}

function matchGrantRoute(pathname: string): GrantRoute | null {
	const match = pathname.match(/^\/api\/v2\/agents\/([^/]+)\/device-grants(?:\/([^/]+))?$/);
	if (!match) return null;
	try {
		const routeAgentId = decodeURIComponent(match[1]);
		const grantId = match[2] ? decodeURIComponent(match[2]) : undefined;
		if (!isSafeDeviceIdentifier(routeAgentId) || (grantId && !isSafeDeviceIdentifier(grantId))) return null;
		return { routeAgentId, ...(grantId ? { grantId } : {}) };
	} catch {
		return null;
	}
}

function extractAgentRoute(pathname: string): string | null {
	const match = pathname.match(/^\/api\/v2\/agents\/([^/]+)\//);
	if (!match) return null;
	try {
		const route = decodeURIComponent(match[1]);
		return isSafeDeviceIdentifier(route) ? route : null;
	} catch {
		return null;
	}
}

function bearerAuthorized(header: string | string[] | undefined, token: string): boolean {
	const raw = Array.isArray(header) ? header[0] : header;
	const match = /^Bearer\s+([^\s]+)$/i.exec(String(raw || ""));
	const actual = Buffer.from(match?.[1] || "", "utf8");
	const expected = Buffer.from(token, "utf8");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseDeviceAuthorization(header: string | string[] | undefined): { grantId: string } | null {
	const raw = Array.isArray(header) ? header[0] : header;
	const match = String(raw || "").match(/^DeviceGrant\s+([A-Za-z0-9._:-]{8,128})$/i);
	return match ? { grantId: match[1] } : null;
}

function singleHeader(req: IncomingMessage, name: string): string {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] || "" : String(value || "");
}

function voiceSessionCorrelation(url: URL, body: Buffer): string | undefined {
	const pathMatch = url.pathname.match(/\/voice-sessions\/([^/]+)(?:\/|$)/);
	if (pathMatch) {
		try {
			const sessionId = decodeURIComponent(pathMatch[1]);
			if (isSafeDeviceIdentifier(sessionId)) return hashDiagnosticCorrelation(sessionId);
		} catch { return undefined; }
	}
	if (!url.pathname.endsWith("/voice-sessions") || body.byteLength > 65_536) return undefined;
	try {
		const value = JSON.parse(body.toString("utf8")) as { identity?: { session_id?: unknown } };
		const sessionId = value.identity?.session_id;
		return isSafeDeviceIdentifier(sessionId) ? hashDiagnosticCorrelation(sessionId) : undefined;
	} catch { return undefined; }
}

function hashDiagnosticCorrelation(value: string): string {
	return voiceReceiptCorrelation(value);
}

function safeDiagnosticIdentity(value: unknown): string {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
		? value
		: "unknown";
}

function isVoiceRecordingMutation(method: string | undefined, pathname: string): boolean {
	return method === "POST"
		&& /^\/api\/v2\/agents\/[^/]+\/voice-sessions\/[^/]+\/recording$/.test(pathname);
}

function isVoiceReceiptMutation(method: string | undefined, pathname: string): boolean {
	return method === "POST"
		&& /^\/api\/v2\/agents\/[^/]+\/voice-sessions\/[^/]+\/(?:events|recording)$/.test(pathname);
}

function sanitizedForwardHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	const blocked = new Set([
		"authorization", "connection", "cookie", "host", "keep-alive", "proxy-connection",
		"transfer-encoding", "upgrade", "cf-connecting-ip", "cf-ipcountry", "cf-ray",
		"x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
		"x-troublemaker-device-timestamp", "x-troublemaker-device-nonce",
		"x-troublemaker-device-body-sha256", "x-troublemaker-device-signature",
		"x-troublemaker-device-subject", "x-troublemaker-verified-device-surface",
		"x-troublemaker-verified-device-relationship",
		"x-troublemaker-verified-voice-agent-correlation",
		"x-troublemaker-verified-voice-request-correlation",
		"x-troublemaker-internal-voice-receipt-proof",
		"x-troublemaker-verified-owner-context",
	]);
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || blocked.has(name.toLowerCase())) continue;
		result[name] = value;
	}
	return result;
}

function readBoundedBody(req: IncomingMessage, maximumBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let finished = false;
		const fail = (error: Error) => {
			if (finished) return;
			finished = true;
			reject(error);
		};
		req.on("data", (chunk: Buffer) => {
			if (finished) return;
			size += chunk.length;
			if (size > maximumBytes) {
				fail(new BoundedBodyError(413, "body_too_large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (finished) return;
			finished = true;
			resolve(Buffer.concat(chunks));
		});
		req.on("aborted", () => fail(new Error("Request aborted")));
		req.on("error", fail);
	});
}

class BoundedBodyError extends Error {
	constructor(readonly status: number, readonly code: string) {
		super(code);
	}
}

function isLoopbackURL(url: URL): boolean {
	return url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
}

export { canonicalDeviceRequest, DEVICE_GRANT_VERSION };
