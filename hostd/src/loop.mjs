import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import {
	PhoneDeliveryUncertainError,
	PhoneProviderRejectedError,
} from "./phone.mjs";
import { LinkedPhoneContextError } from "./router.mjs";
import {
	openPrivateValue,
	sealPrivateValue,
	stablePrivateKey,
} from "./security.mjs";

// Loop (LoopMessage) is a separate iMessage sender. Its traffic enters the
// same Hostd phone pipeline as SMS: the per-person phone principal, the phone
// conversation/outbox tables, and the phone ledger projections (/app, Zulip).
// Only the provider edge differs: Loop authenticates webhooks with a
// dashboard-configured Authorization header and identifies events by
// webhook_id.

export const LOOP_PROVIDER = "loop";
const LOOP_SEEN_SOURCE = "loop-webhook";
const MAXIMUM_BODY_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_PER_CLIENT = 30;
const RATE_GLOBAL = 180;
const OPT_OUT_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const OPT_IN_WORDS = new Set(["start", "unstop", "yes"]);
const STATUS_BY_EVENT = new Map([
	["message_scheduled", "queued"],
	["message_sent", "sent"],
	["message_delivered", "delivered"],
	["message_failed", "failed"],
]);

function object(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
	return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function normalizePhoneAddress(value) {
	const address = typeof value === "string" ? value.replaceAll(/[().\s-]/g, "") : "";
	return /^\+[1-9]\d{7,14}$/.test(address) ? address : "";
}

function equal(left, right) {
	const actual = Buffer.from(left);
	const expected = Buffer.from(right);
	return actual.length > 0
		&& actual.length === expected.length
		&& timingSafeEqual(actual, expected);
}

export class LoopIngressRateLimiter {
	constructor({
		windowMs = RATE_WINDOW_MS,
		perClient = RATE_PER_CLIENT,
		global = RATE_GLOBAL,
	} = {}) {
		this.windowMs = windowMs;
		this.perClient = perClient;
		this.globalLimit = global;
		this.windowStartedAt = 0;
		this.globalCount = 0;
		this.clientCounts = new Map();
	}

	allow(client, now = Date.now()) {
		if (
			this.windowStartedAt === 0
			|| now < this.windowStartedAt
			|| now - this.windowStartedAt >= this.windowMs
		) {
			this.windowStartedAt = now;
			this.globalCount = 0;
			this.clientCounts.clear();
		}
		this.globalCount += 1;
		if (this.globalCount > this.globalLimit) return false;
		const count = (this.clientCounts.get(client) || 0) + 1;
		this.clientCounts.set(client, count);
		return count <= this.perClient;
	}
}

function loopIngressClient(request) {
	const remote = request.socket?.remoteAddress || "";
	const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
	const forwarded = String(request.headers?.["cf-connecting-ip"] || "").trim();
	if (local && isIP(forwarded)) return forwarded;
	return isIP(remote) ? remote : "unknown";
}

class LoopIngressHttpError extends Error {
	constructor(status) {
		super(`loop ingress rejected request with HTTP ${status}`);
		this.status = status;
	}
}

/**
 * Loop sends the exact Authorization header value configured in its dashboard.
 * Accept that value verbatim, or as a Bearer token, compared in constant time.
 */
export function verifyLoopWebhook(headers, secret) {
	if (typeof secret !== "string" || secret.length < 24) return false;
	const header = String(headers?.authorization || "").trim();
	if (!header) return false;
	const bearer = header.replace(/^Bearer\s+/i, "");
	return equal(header, secret) || equal(bearer, secret);
}

export function loopProviderMessageId(messageId) {
	return `${LOOP_PROVIDER}:${messageId}`;
}

function present(value) {
	if (value === undefined || value === null) return false;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

function isNonDirectText(payload) {
	const messageType = (firstString(payload.message_type) || "text").toLowerCase();
	// Any non-empty or malformed attachments field is media; only an absent,
	// null, or empty-array field counts as text-only.
	const attachments = payload.attachments;
	const noAttachments = attachments === undefined
		|| attachments === null
		|| (Array.isArray(attachments) && attachments.length === 0);
	return present(payload.group)
		|| messageType !== "text"
		|| !noAttachments;
}

export class LoopDirectProvider {
	constructor(config, { fetchImpl = fetch } = {}) {
		this.config = config;
		this.fetch = fetchImpl;
	}

	async sendDirect(contactAddress, text) {
		// Loop auto-selects iMessage/SMS/RCS unless channel is pinned; this lane
		// must never silently degrade to SMS.
		const body = { contact: contactAddress, text, channel: "imessage" };
		if (this.config.senderId) body.sender = this.config.senderId;
		let response;
		try {
			response = await this.fetch(`${this.config.apiBaseUrl}/api/v1/message/send/`, {
				method: "POST",
				headers: {
					authorization: this.config.apiKey,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			throw new PhoneDeliveryUncertainError(
				`provider request ended without a definitive response: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const responseText = await response.text();
		let result = {};
		try {
			result = object(responseText ? JSON.parse(responseText) : {});
		} catch {
			// Never echo arbitrary provider bodies into errors.
		}
		if (!response.ok || result.success === false) {
			// Loop's `message` is free text; keep only the numeric code if any.
			throw new PhoneProviderRejectedError(response.status, {
				code: Number.isInteger(result.code) ? String(result.code) : undefined,
			});
		}
		const messageId = firstString(result.message_id);
		if (!messageId) {
			throw new PhoneDeliveryUncertainError("provider accepted delivery without a message id");
		}
		return { providerMessageId: loopProviderMessageId(messageId), status: "queued" };
	}
}

export class LoopGateway {
	constructor({
		config,
		store,
		router,
		routingKey,
		scheduler,
		controlNotifier,
		phoneGateway,
		fetchImpl = fetch,
	}) {
		this.config = config;
		this.store = store;
		this.router = router;
		this.routingKey = routingKey;
		this.scheduler = scheduler;
		this.controlNotifier = controlNotifier;
		this.phoneGateway = phoneGateway;
		// Direct-neuron replies for Loop edges are sent by the phone flusher.
		phoneGateway?.registerReplyTransport(LOOP_PROVIDER, this);
		this.provider = new LoopDirectProvider(config.loop, { fetchImpl });
		this.rateLimiter = new LoopIngressRateLimiter();
		this.server = null;
		this.stopped = true;
	}

	async start() {
		if (!this.config.loop || !this.stopped) return;
		this.stopped = false;
		const ingress = this.config.loop.ingress;
		this.server = createServer((request, response) => void this.handle(request, response));
		await new Promise((resolvePromise, reject) => {
			this.server.once("error", reject);
			this.server.listen(ingress.port, ingress.host, resolvePromise);
		});
		console.log(`troublemaker-hostd: loop ingress listening on ${ingress.host}:${ingress.port}`);
	}

	async stop() {
		if (this.stopped) return;
		this.stopped = true;
		if (this.server) {
			const server = this.server;
			this.server = null;
			await new Promise((resolvePromise) => server.close(resolvePromise));
		}
	}

	async handle(request, response) {
		try {
			if (!this.rateLimiter.allow(loopIngressClient(request))) {
				request.resume();
				response.writeHead(429, { "cache-control": "no-store", "retry-after": "60" });
				response.end();
				return;
			}
			if (request.method !== "POST" || request.url !== this.config.loop.ingress.path) {
				request.resume();
				response.writeHead(404, { "cache-control": "no-store" });
				response.end();
				return;
			}
			if (!verifyLoopWebhook(request.headers, this.config.loop.webhookSecret)) {
				request.resume();
				response.writeHead(401, { "cache-control": "no-store" });
				response.end();
				return;
			}
			const contentType = String(request.headers["content-type"] || "")
				.split(";", 1)[0]
				.trim()
				.toLowerCase();
			if (contentType !== "application/json") {
				request.resume();
				throw new LoopIngressHttpError(415);
			}
			const declaredLength = Number(request.headers["content-length"]);
			if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_BODY_BYTES) {
				request.resume();
				throw new LoopIngressHttpError(413);
			}
			const chunks = [];
			let length = 0;
			for await (const chunk of request) {
				length += chunk.length;
				if (length > MAXIMUM_BODY_BYTES) {
					request.resume();
					throw new LoopIngressHttpError(413);
				}
				chunks.push(chunk);
			}
			let payload;
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				throw new LoopIngressHttpError(400);
			}
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				throw new LoopIngressHttpError(400);
			}
			const disposition = this.acceptWebhook(payload);
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify({ ok: true, disposition }));
		} catch (error) {
			const status = error instanceof LoopIngressHttpError ? error.status : 500;
			if (status === 500) {
				console.error(
					"troublemaker-hostd: loop webhook failed:",
					error instanceof Error ? error.message : String(error),
				);
			}
			if (!response.headersSent) response.writeHead(status, { "cache-control": "no-store" });
			response.end();
		}
	}

	/** Accept an already-authenticated Loop webhook body. */
	acceptWebhook(payload, { observedAt = Date.now() } = {}) {
		const webhookId = firstString(payload.webhook_id);
		const messageId = firstString(payload.message_id);
		const event = (firstString(payload.event) || "").toLowerCase();
		if (!webhookId || !event) throw new Error("loop webhook lacks provider identity");
		if (this.store.hasSeen(LOOP_SEEN_SOURCE, webhookId)) return "duplicate";
		const done = (disposition) => {
			this.store.markSeen(LOOP_SEEN_SOURCE, webhookId, disposition);
			return disposition;
		};

		const senderId = firstString(payload.sender);
		if (this.config.loop.senderId && senderId !== this.config.loop.senderId) {
			return done("unrelated_sender");
		}

		// Receipts for our own outbound messages: update delivery status only.
		// They carry the outbound text and must never enqueue an inbound turn.
		const status = STATUS_BY_EVENT.get(event);
		if (status) {
			if (messageId) {
				const providerMessageId = loopProviderMessageId(messageId);
				this.store.updatePhoneOutboxStatus(providerMessageId, status);
				this.store.updatePhoneApiProviderStatus(providerMessageId, status);
			}
			return done("status");
		}
		if (event !== "message_inbound") return done("ignored_event");
		if (!messageId) throw new Error("loop inbound webhook lacks message id");

		const from = normalizePhoneAddress(payload.contact);
		if (!from) return done("quarantined:non_phone_contact");
		if (!this.config.loop.allowedContacts.includes(from)) return done("unrelated_contact");
		// This lane is iMessage only; Loop SMS/RCS/fallback traffic must not enter it.
		if (firstString(payload.channel) !== "imessage") return done("quarantined:non_imessage");
		if (isNonDirectText(payload)) return done("quarantined:non_direct_text");

		const text = firstString(payload.text) || "";
		const keyword = text.trim().toLowerCase();
		// Empty webhooks are quarantined before any linked route is created or touched.
		if (!text) return done("quarantined:empty");

		let conversation;
		try {
			conversation = this.prepareConversation(from);
		} catch (error) {
			if (error instanceof LinkedPhoneContextError) return done(`quarantined:no_canonical_conversation:${error.reason}`);
			throw error;
		}
		if (OPT_OUT_WORDS.has(keyword) || OPT_IN_WORDS.has(keyword)) {
			const stored = this.store.upsertPhoneConversation(conversation);
			const optedOut = OPT_OUT_WORDS.has(keyword);
			this.store.setPhoneOptOut(stored.principalHash, optedOut);
			return done(optedOut ? "opted_out" : "opted_in");
		}
		// Feature senders talk to the direct phone agent. The canonical SMS
		// conversation owns that session and history; Loop is only this turn's
		// reply transport.
		if (this.phoneGateway?.isApiAgentFeatureSender(from)) {
			const replyConversation = this.store.upsertPhoneConversation(conversation);
			let canonical;
			try {
				canonical = this.canonicalConversation(replyConversation);
			} catch (error) {
				if (error instanceof LinkedPhoneContextError) return done(`quarantined:no_canonical_conversation:${error.reason}`);
				throw error;
			}
			const disposition = this.phoneGateway.queueApiAgentInbound({
				conversation: canonical,
				replyConversation,
				providerMessageId: loopProviderMessageId(messageId),
				text,
				timestamp: new Date(observedAt).toISOString(),
			});
			return done(disposition);
		}

		const providerMessageId = loopProviderMessageId(messageId);
		const occurredAt = new Date(observedAt).toISOString();
		this.store.upsertPhoneInbound({
			conversation,
			event: {
				id: `phone:${providerMessageId}`,
				source: "phone",
				providerMessageId,
				providerThreadId: conversation.providerThreadId,
				principalHash: conversation.principalHash,
				targetId: conversation.targetId,
				contextId: conversation.contextId,
				availableAt: new Date(
					observedAt + (this.config.scheduler?.relationshipBurstWindowMs ?? 0),
				).toISOString(),
				payload: {
					direction: "inbound",
					sender: `iMessage ending ${conversation.contactLastFour}`,
					recipient: "Business iMessage",
					message: {
						id: providerMessageId,
						body: text,
						timestamp: occurredAt,
					},
					phone: {
						provider: LOOP_PROVIDER,
						threadTarget: conversation.threadTarget,
						displayName: `iMessage •••• ${conversation.contactLastFour}`,
					},
					route: { projectSlug: "intake" },
				},
			},
		});
		this.controlNotifier?.wake();
		this.scheduler?.pump();
		return done("queued");
	}

	canonicalConversation(edge) {
		const candidates = this.store.listActivePhoneConversationsForPrincipal(
			edge.principalHash,
			this.config.phone.provider,
		);
		const [canonical] = candidates;
		if (
			candidates.length !== 1
			|| canonical.contextId !== edge.contextId
			|| canonical.targetId !== edge.targetId
		) throw new LinkedPhoneContextError(candidates.length > 1 ? "ambiguous" : "mismatch");
		return canonical;
	}

	prepareConversation(contactAddress) {
		const providerThreadId = stablePrivateKey(
			this.routingKey,
			"phone-provider-thread",
			`${LOOP_PROVIDER}\0${this.config.loop.senderId || ""}\0${contactAddress}`,
		);
		const threadTarget = `phone-${stablePrivateKey(
			this.routingKey,
			"phone-thread-target",
			providerThreadId,
		).slice(0, 20)}`;
		const existing = this.store.getPhoneConversation(threadTarget);
		const contactLastFour = contactAddress.slice(-4);
		// One person, one conversation: Loop keeps its own provider edge but joins
		// the person's single active SMS conversation context.
		const route = this.router.resolveLinkedPhone({
			providerThreadId,
			contactAddress,
			canonicalProvider: this.config.phone.provider,
			label: `iMessage •••• ${contactLastFour}`,
		});
		return {
			threadTarget,
			provider: LOOP_PROVIDER,
			providerThreadId,
			principalHash: route.principalHash,
			targetId: route.targetId,
			contextId: route.contextId,
			contactCiphertext: existing?.contactCiphertext || sealPrivateValue(
				this.routingKey,
				"phone-contact",
				contactAddress,
			),
			contactLastFour,
		};
	}

	async sendDirect(conversation, text) {
		if (conversation.provider !== LOOP_PROVIDER) throw new Error("conversation is not a Loop conversation");
		if (conversation.status !== "active") throw new Error("phone conversation is not active");
		if (this.store.isPhoneOptedOut(conversation.principalHash)) {
			throw new Error("phone recipient has opted out");
		}
		const contactAddress = openPrivateValue(
			this.routingKey,
			"phone-contact",
			conversation.contactCiphertext,
		);
		if (!this.config.loop.allowedContacts.includes(contactAddress)) {
			throw new Error("loop recipient is not allowlisted");
		}
		return this.provider.sendDirect(contactAddress, text);
	}
}
