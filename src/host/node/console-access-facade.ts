import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import {
	DEVICE_GRANT_VERSION,
	deviceRequestScope,
	isSafeDeviceIdentifier,
	sha256Hex,
	type CanonicalDeviceRequestInput,
	type DeviceGrantEnrollmentRequest,
	canonicalDeviceRequest,
} from "../../console/device-grants.js";
import { DeviceGrantStore, DeviceGrantStoreError } from "./device-grant-store.js";

const EMPTY_SHA256 = sha256Hex(new Uint8Array());
const DEFAULT_MAXIMUM_BODY_BYTES = 2_100_000;

export interface ConsoleAccessFacadeOptions {
	ownerToken: string;
	upstreamBaseURL: URL;
	upstreamAuthorization?: string;
	allowedAgentRoutes: string[];
	grantStore: DeviceGrantStore;
	maximumBodyBytes?: number;
	fetchImplementation?: typeof fetch;
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
		const url = new URL(req.url || "/", "http://localhost");
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
		if (this.ownerAuthorized(req.headers.authorization)) {
			this.forward(req, res, url, body);
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
		try {
			this.options.grantStore.verifyRequest(
				authorization.grantId,
				scope,
				routeAgentId,
				canonical,
				signature,
			);
		} catch (error) {
			if (error instanceof DeviceGrantStoreError) {
				this.sendError(res, error.status, error.code);
				return;
			}
			throw error;
		}
		this.forward(req, res, url, body);
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

	private forward(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void {
		const upstreamURL = new URL(`${url.pathname}${url.search}`, this.options.upstreamBaseURL);
		const headers = sanitizedForwardHeaders(req.headers);
		if (this.options.upstreamAuthorization) headers.authorization = this.options.upstreamAuthorization;
		headers.host = upstreamURL.host;
		headers["content-length"] = String(body.byteLength);
		const request = upstreamURL.protocol === "https:" ? httpsRequest : httpRequest;
		const upstream = request(upstreamURL, {
			method: req.method,
			headers,
		}, (upstreamResponse) => {
			const responseHeaders = { ...upstreamResponse.headers };
			delete responseHeaders["set-cookie"];
			delete responseHeaders["set-cookie2"];
			responseHeaders["cache-control"] = "no-cache, no-store, no-transform";
			if (String(responseHeaders["content-type"] || "").startsWith("text/event-stream")) {
				delete responseHeaders["content-length"];
				responseHeaders["x-accel-buffering"] = "no";
			}
			res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
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
		const raw = Array.isArray(header) ? header[0] : header;
		const supplied = String(raw || "").replace(/^Bearer\s+/i, "");
		const actual = Buffer.from(supplied);
		const expected = Buffer.from(this.options.ownerToken);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
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

function parseDeviceAuthorization(header: string | string[] | undefined): { grantId: string } | null {
	const raw = Array.isArray(header) ? header[0] : header;
	const match = String(raw || "").match(/^DeviceGrant\s+([A-Za-z0-9._:-]{8,128})$/i);
	return match ? { grantId: match[1] } : null;
}

function singleHeader(req: IncomingMessage, name: string): string {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] || "" : String(value || "");
}

function sanitizedForwardHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	const blocked = new Set([
		"authorization", "connection", "cookie", "host", "keep-alive", "proxy-connection",
		"transfer-encoding", "upgrade", "cf-connecting-ip", "cf-ipcountry", "cf-ray",
		"x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
		"x-troublemaker-device-timestamp", "x-troublemaker-device-nonce",
		"x-troublemaker-device-body-sha256", "x-troublemaker-device-signature",
		"x-troublemaker-device-subject",
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
