import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
	PhoneDeliveryUncertainError,
	PhoneProviderRejectedError,
} from "./phone.mjs";
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

function isNonDirectText(payload) {
	const messageType = (firstString(payload.message_type) || "text").toLowerCase();
	const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
	return (payload.group !== undefined && payload.group !== null && payload.group !== "")
		|| messageType !== "text"
		|| attachments.length > 0;
}

export class LoopDirectProvider {
	constructor(config, { fetchImpl = fetch } = {}) {
		this.config = config;
		this.fetch = fetchImpl;
	}

	async sendDirect(contactAddress, text) {
		const body = { contact: contactAddress, text };
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
		fetchImpl = fetch,
	}) {
		this.config = config;
		this.store = store;
		this.router = router;
		this.routingKey = routingKey;
		this.scheduler = scheduler;
		this.controlNotifier = controlNotifier;
		this.provider = new LoopDirectProvider(config.loop, { fetchImpl });
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
			if (request.method !== "POST" || request.url?.split("?", 1)[0] !== this.config.loop.ingress.path) {
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
			const chunks = [];
			let length = 0;
			for await (const chunk of request) {
				length += chunk.length;
				if (length > MAXIMUM_BODY_BYTES) throw new Error("webhook body exceeds limit");
				chunks.push(chunk);
			}
			let payload;
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				response.writeHead(400, { "cache-control": "no-store" });
				response.end();
				return;
			}
			const disposition = this.acceptWebhook(object(payload));
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(JSON.stringify({ ok: true, disposition }));
		} catch (error) {
			console.error(
				"troublemaker-hostd: loop webhook failed:",
				error instanceof Error ? error.message : String(error),
			);
			response.writeHead(500, { "cache-control": "no-store" });
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
		if (this.config.loop.senderId && senderId && senderId !== this.config.loop.senderId) {
			return done("unrelated_sender");
		}

		// Receipts for our own outbound messages: update delivery status only.
		// They carry the outbound text and must never enqueue an inbound turn.
		const status = STATUS_BY_EVENT.get(event);
		if (status) {
			if (messageId) {
				const providerMessageId = loopProviderMessageId(messageId);
				this.store.updatePhoneOutboxStatus(providerMessageId, status);
			}
			return done("status");
		}
		if (event !== "message_inbound") return done("ignored_event");
		if (!messageId) throw new Error("loop inbound webhook lacks message id");

		const from = normalizePhoneAddress(payload.contact);
		if (!from) return done("quarantined:non_phone_contact");
		if (!this.config.loop.allowedContacts.includes(from)) return done("unrelated_contact");
		if (isNonDirectText(payload)) return done("quarantined:non_direct_text");

		const text = firstString(payload.text) || "";
		const keyword = text.trim().toLowerCase();
		if (OPT_OUT_WORDS.has(keyword) || OPT_IN_WORDS.has(keyword)) {
			const conversation = this.store.upsertPhoneConversation(this.prepareConversation(from));
			const optedOut = OPT_OUT_WORDS.has(keyword);
			this.store.setPhoneOptOut(conversation.principalHash, optedOut);
			return done(optedOut ? "opted_out" : "opted_in");
		}
		if (!text) return done("quarantined:empty");

		const conversation = this.prepareConversation(from);
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
		const route = this.router.resolvePhone({
			providerThreadId,
			contactAddress,
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
