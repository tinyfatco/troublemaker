import {
	createDecipheriv,
	createHash,
	createHmac,
	timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import {
	openPrivateValue,
	sealPrivateValue,
	stablePrivateKey,
} from "./security.mjs";

const SIGNATURE_MAX_AGE_MILLISECONDS = 5 * 60 * 1000;
const STATUS_EVENTS = new Set([
	"message.queued",
	"message.sent",
	"message.delivered",
	"message.failed",
	"message.bounced",
	"message.rejected",
	"message.undelivered",
]);
const OPT_OUT_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const OPT_IN_WORDS = new Set(["start", "unstop", "yes"]);

function object(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
	return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function strings(value) {
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
	return typeof value === "string" && value.trim() ? [value] : [];
}

function normalizePhoneAddress(value) {
	const address = typeof value === "string" ? value.replaceAll(/[().\s-]/g, "") : "";
	return /^\+[1-9]\d{7,14}$/.test(address) ? address : "";
}

function timestampMilliseconds(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return 0;
	return number > 9_999_999_999 ? number : number * 1000;
}

function equal(left, right) {
	const actual = Buffer.from(left);
	const expected = Buffer.from(right);
	return actual.length > 0
		&& actual.length === expected.length
		&& timingSafeEqual(actual, expected);
}

export function verifySendlyWebhook(rawBody, headers, secret, now = Date.now()) {
	const timestamp = String(headers["x-sendly-timestamp"] || "");
	const signature = String(headers["x-sendly-signature"] || "");
	const observedAt = timestampMilliseconds(timestamp);
	if (!observedAt || Math.abs(now - observedAt) > SIGNATURE_MAX_AGE_MILLISECONDS) return false;
	const computed = `sha256=${createHmac("sha256", secret)
		.update(`${timestamp}.${rawBody}`)
		.digest("hex")}`;
	return equal(signature, computed);
}

function sendlyObject(payload) {
	const raw = object(payload);
	return object(object(raw.data).object ?? raw.object ?? raw);
}

function eventType(payload, message) {
	return (firstString(payload.type, message.event, message.event_type, message.eventType) || "")
		.toLowerCase();
}

function messageId(payload, message) {
	return firstString(message.id, message.message_id, message.messageId, payload.message_id);
}

function eventId(payload, message) {
	return firstString(payload.id, payload.event_id, payload.eventId)
		|| `${eventType(payload, message)}:${messageId(payload, message)}`;
}

function sendlyTimestamp(payload, message) {
	return firstString(
		message.created_at,
		message.createdAt,
		message.timestamp,
		payload.created_at,
		payload.createdAt,
		payload.timestamp,
	) || new Date().toISOString();
}

function statusFor(type, message) {
	const explicit = firstString(message.status)?.toLowerCase();
	if (["queued", "sent", "delivered", "failed", "rejected"].includes(explicit)) return explicit;
	if (type.endsWith(".queued")) return "queued";
	if (type.endsWith(".sent")) return "sent";
	if (type.endsWith(".delivered")) return "delivered";
	if (type.endsWith(".failed") || type.endsWith(".bounced") || type.endsWith(".undelivered")) {
		return "failed";
	}
	return "rejected";
}

function isGroupOrMedia(message) {
	const metadata = object(message.metadata);
	const destinations = strings(message.to ?? message.to_number ?? message.toNumber);
	const media = [
		...strings(message.media_urls),
		...strings(message.mediaUrls),
	];
	// Sendly may infer a group key for an ordinary two-party thread. Ignore that
	// marker only when the signed payload contains no independent group evidence.
	const groupInferred = metadata.groupInferred === true || metadata.group_inferred === true;
	const groupIdentifier = firstString(
		metadata.groupKey,
		metadata.group_key,
		metadata.groupMessageId,
		metadata.group_message_id,
		message.groupMessageId,
		message.group_message_id,
	);
	return (metadata.group === true && !groupInferred)
		|| destinations.length !== 1
		|| strings(metadata.cc).length > 0
		|| strings(metadata.participants).length > 0
		|| (!groupInferred && Boolean(groupIdentifier))
		|| media.length > 0
		|| (firstString(message.message_format, message.messageFormat, message.format) || "sms").toLowerCase() !== "sms";
}

export class PhoneDeliveryUncertainError extends Error {
	constructor(message) {
		super(message);
		this.name = "PhoneDeliveryUncertainError";
	}
}

export class SendlyDirectProvider {
	constructor(config, { fetchImpl = fetch } = {}) {
		this.config = config;
		this.fetch = fetchImpl;
	}

	async sendDirect(contactAddress, text) {
		let response;
		try {
			response = await this.fetch(`${this.config.apiBaseUrl}/messages`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.config.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					to: contactAddress,
					from: this.config.senderAddress,
					text,
					messageType: "transactional",
				}),
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
			result = responseText ? JSON.parse(responseText) : {};
		} catch {
			// The bounded status error below intentionally excludes arbitrary provider HTML.
		}
		if (!response.ok) {
			throw new Error(`phone provider rejected delivery with HTTP ${response.status}`);
		}
		const providerMessageId = firstString(result.id, result.message_id, result.messageId);
		if (!providerMessageId) {
			throw new PhoneDeliveryUncertainError("provider accepted delivery without a message id");
		}
		return {
			providerMessageId,
			status: statusFor("", object(result)),
		};
	}
}

export class PhoneGateway {
	constructor({
		config,
		store,
		router,
		routingKey,
		scheduler,
		controlNotifier,
		firstContact,
		fetchImpl = fetch,
	}) {
		this.config = config;
		this.store = store;
		this.router = router;
		this.routingKey = routingKey;
		this.scheduler = scheduler;
		this.controlNotifier = controlNotifier;
		this.firstContact = firstContact;
		this.fetch = fetchImpl;
		this.provider = new SendlyDirectProvider(config.phone, { fetchImpl });
		this.server = null;
		this.pollTimer = null;
		this.currentPoll = null;
		this.firstContactTimer = null;
		this.currentFirstContactFlush = null;
		this.stopped = true;
	}

	async start() {
		if (!this.config.phone || !this.stopped) return;
		this.stopped = false;
		if (this.config.phone.ingress) {
			this.server = createServer((request, response) => void this.handle(request, response));
			await new Promise((resolvePromise, reject) => {
				this.server.once("error", reject);
				this.server.listen(
					this.config.phone.ingress.port,
					this.config.phone.ingress.host,
					resolvePromise,
				);
			});
			console.log(
				`troublemaker-hostd: phone ingress listening on ${this.config.phone.ingress.host}:${this.config.phone.ingress.port}`,
			);
		}
		if (this.config.phone.relay) {
			await this.pollOnce();
			this.pollTimer = setInterval(
				() => void this.pollOnce().catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					this.store.setMeta("phone:last_poll_error", message.slice(0, 1000));
					console.error("troublemaker-hostd: phone relay poll failed:", message);
				}),
				this.config.phone.relay.pollIntervalSeconds * 1000,
			);
			this.pollTimer.unref();
			console.log("troublemaker-hostd: phone relay polling active");
		}
			if (this.firstContact) {
				await this.flushFirstContacts();
				this.firstContactTimer = setInterval(
					() => this.requestFirstContactFlush(),
				(this.firstContact.pollIntervalSeconds ?? 5) * 1000,
			);
			this.firstContactTimer.unref();
		}
	}

	async stop() {
		if (this.stopped) return;
		this.stopped = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
		if (this.firstContactTimer) clearInterval(this.firstContactTimer);
		this.firstContactTimer = null;
		await this.currentPoll;
		await this.currentFirstContactFlush;
		if (this.server) {
			const server = this.server;
			this.server = null;
			await new Promise((resolvePromise) => server.close(resolvePromise));
		}
	}

	async handle(request, response) {
		try {
			const ingress = this.config.phone.ingress;
			if (
				!ingress
				|| request.method !== "POST"
				|| request.url?.split("?", 1)[0] !== ingress.path
			) {
				response.writeHead(404, { "cache-control": "no-store" });
				response.end();
				return;
			}
			const chunks = [];
			let length = 0;
			for await (const chunk of request) {
				length += chunk.length;
				if (length > 256 * 1024) throw new Error("webhook body exceeds limit");
				chunks.push(chunk);
			}
			const rawBody = Buffer.concat(chunks).toString("utf8");
			try {
				const result = await this.acceptSignedWebhook(rawBody, request.headers);
				response.writeHead(200, {
					"content-type": "application/json",
					"cache-control": "no-store",
				});
				response.end(JSON.stringify({ ok: true, disposition: result }));
			} catch (error) {
				if (error?.code === "invalid_phone_signature") {
					response.writeHead(401, { "cache-control": "no-store" });
					response.end();
					return;
				}
				if (error instanceof SyntaxError) {
					response.writeHead(400, { "cache-control": "no-store" });
					response.end();
					return;
				}
				throw error;
			}
		} catch (error) {
			console.error(
				"troublemaker-hostd: phone webhook failed:",
				error instanceof Error ? error.message : String(error),
			);
			response.writeHead(500, { "cache-control": "no-store" });
			response.end();
		}
	}

	async acceptSignedWebhook(rawBody, headers, observedAt = Date.now()) {
		if (!verifySendlyWebhook(
			rawBody,
			headers,
			this.config.phone.webhookSecret,
			observedAt,
		)) {
			const error = new Error("invalid phone webhook signature");
			error.code = "invalid_phone_signature";
			throw error;
		}
		return this.acceptWebhook(object(JSON.parse(rawBody)), { observedAt });
	}

	async pollOnce() {
		if (!this.config.phone.relay || this.stopped) return;
		if (this.currentPoll) return this.currentPoll;
		this.currentPoll = this.pollRelay();
		try {
			await this.currentPoll;
			this.store.setMeta("phone:last_poll_error", "");
		} finally {
			this.currentPoll = null;
		}
	}

	async pollRelay() {
		const relay = this.config.phone.relay;
		const response = await this.fetch(`${relay.url}/pull`, {
			method: "POST",
			headers: { authorization: `Bearer ${relay.token}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`phone relay pull returned HTTP ${response.status}`);
		const payload = object(await response.json());
		if (!Array.isArray(payload.events)) throw new Error("phone relay pull response is malformed");
		const acknowledged = [];
		for (const rawEvent of payload.events) {
			const event = object(rawEvent);
			try {
				const plaintext = decryptRelayEvent(event, relay.encryptionKey);
				if (plaintext.receivedAt !== event.receivedAt) {
					throw new Error("phone relay receipt timestamp mismatch");
				}
				await this.acceptSignedWebhook(
					plaintext.rawBody,
					{
						"x-sendly-signature": plaintext.signature,
						"x-sendly-timestamp": plaintext.timestamp,
					},
					Date.parse(plaintext.receivedAt),
				);
				acknowledged.push(event.id);
			} catch (error) {
				console.error(
					`troublemaker-hostd: phone relay event ${String(event.id || "unknown")} held:`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		if (acknowledged.length === 0) return;
		const ack = await this.fetch(`${relay.url}/ack`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${relay.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ ids: acknowledged }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!ack.ok) throw new Error(`phone relay ack returned HTTP ${ack.status}`);
	}

	async flushFirstContacts() {
		if (!this.firstContact) return;
		if (this.currentFirstContactFlush) return this.currentFirstContactFlush;
		this.currentFirstContactFlush = this.deliverFirstContacts();
		try {
			await this.currentFirstContactFlush;
		} finally {
			this.currentFirstContactFlush = null;
		}
	}

	requestFirstContactFlush() {
		void this.flushFirstContacts().catch(() => {
			console.error("troublemaker-hostd: relationship event outbox flush failed");
		});
	}

	async deliverFirstContacts() {
		const maximumAttempts = this.firstContact.maximumAttempts ?? 12;
		const leaseSeconds = this.firstContact.leaseSeconds ?? 60;
		for (let delivered = 0; delivered < 25; delivered++) {
			const record = this.store.claimRelationshipEventOutbox({
				kind: this.firstContact.kind,
				maximumAttempts,
				leaseSeconds,
			});
			if (!record) return;
			try {
				const receipt = await this.firstContact.deliver({
					eventId: record.idempotencyKey,
					payload: JSON.parse(record.payloadJson),
					attempt: record.attempts,
				});
				this.store.completeRelationshipEventOutbox(
					record.idempotencyKey,
					receipt?.receiptId,
				);
			} catch (error) {
				const baseDelay = this.firstContact.retryBaseSeconds ?? 30;
				const maximumDelay = this.firstContact.retryMaximumSeconds ?? 3600;
				const retryDelaySeconds = Math.min(
					maximumDelay,
					baseDelay * (2 ** Math.max(0, record.attempts - 1)),
				);
				this.store.failRelationshipEventOutbox(
					record.idempotencyKey,
					error instanceof Error ? error.message : String(error),
					{ maximumAttempts, retryDelaySeconds },
				);
			}
		}
	}

	async acceptWebhook(payload, { observedAt = Date.now() } = {}) {
		const message = sendlyObject(payload);
		const type = eventType(payload, message);
		const providerMessageId = messageId(payload, message);
		const providerEventId = eventId(payload, message);
		if (!providerMessageId || !providerEventId) throw new Error("phone webhook lacks provider identity");
		if (this.store.hasSeen("phone-webhook", providerEventId)) return "duplicate";

		if (STATUS_EVENTS.has(type)) {
			const from = normalizePhoneAddress(firstString(message.from, message.from_number, message.fromNumber));
			if (from === this.config.phone.senderAddress) {
				this.store.updatePhoneOutboxStatus(providerMessageId, statusFor(type, message));
			}
			this.store.markSeen("phone-webhook", providerEventId, "status");
			return "status";
		}

		const from = normalizePhoneAddress(firstString(message.from, message.from_number, message.fromNumber));
		const destinations = strings(message.to ?? message.to_number ?? message.toNumber)
			.map(normalizePhoneAddress)
			.filter(Boolean);
		const sender = destinations[0] || "";
		if (sender !== this.config.phone.senderAddress) {
			this.store.markSeen("phone-webhook", providerEventId, "unrelated_sender");
			return "unrelated_sender";
		}
		if (!from || isGroupOrMedia(message)) {
			this.store.markSeen("phone-webhook", providerEventId, "quarantined:non_direct_text");
			return "quarantined:non_direct_text";
		}
		if (!["message.received", "message.opt_out", "message.opt_in"].includes(type)) {
			this.store.markSeen("phone-webhook", providerEventId, "ignored_event");
			return "ignored_event";
		}

		const text = firstString(message.text, message.body, message.message) || "";
		const keyword = text.trim().toLowerCase();
		if (type === "message.opt_out" || OPT_OUT_WORDS.has(keyword)) {
			const conversation = this.store.upsertPhoneConversation(this.prepareConversation(from));
			this.store.setPhoneOptOut(conversation.principalHash, true);
			this.store.markSeen("phone-webhook", providerEventId, "opted_out");
			return "opted_out";
		}
		if (type === "message.opt_in" || OPT_IN_WORDS.has(keyword)) {
			const conversation = this.store.upsertPhoneConversation(this.prepareConversation(from));
			this.store.setPhoneOptOut(conversation.principalHash, false);
			this.store.markSeen("phone-webhook", providerEventId, "opted_in");
			return "opted_in";
		}
		if (type !== "message.received") {
			this.store.markSeen("phone-webhook", providerEventId, "ignored_event");
			return "ignored_event";
		}
		if (!text) {
			this.store.markSeen("phone-webhook", providerEventId, "quarantined:empty");
			return "quarantined:empty";
		}

		let attributionResolution;
		if (this.firstContact?.resolveAttribution) {
			try {
				attributionResolution = this.firstContact.resolveAttribution({
					messageText: text,
					observedAt,
					provider: this.config.phone.provider,
					providerEventId,
					providerMessageId,
				});
			} catch {
				// Attribution is an optional conversion gate. Any verifier failure fails closed.
				attributionResolution = undefined;
			}
		}
		const attributedText = typeof attributionResolution?.messageText === "string"
			? attributionResolution.messageText
			: text;
		const attributionClaim = attributionResolution?.claim
			? {
				claimKey: attributionResolution.claim.claimKey,
				source: attributionResolution.claim.source,
				campaignId: attributionResolution.claim.campaignId,
				observedAt: new Date(observedAt).toISOString(),
			}
			: undefined;
		const conversation = this.prepareConversation(from);
		const occurredAt = sendlyTimestamp(payload, message);
		const relationshipEvent = this.firstContact && attributionClaim
			? {
				kind: this.firstContact.kind,
				...this.firstContact.createRecord({
					contactAddress: from,
					provider: this.config.phone.provider,
					providerEventId,
					providerMessageId,
					occurredAt,
					threadTarget: conversation.threadTarget,
					attribution: attributionClaim,
				}),
			}
			: undefined;
		const committed = this.store.upsertPhoneInbound({
			conversation,
			attributionClaim,
			relationshipEvent,
			event: {
				id: `phone:${providerMessageId}`,
				source: "phone",
				providerMessageId,
				providerThreadId: conversation.providerThreadId,
				principalHash: conversation.principalHash,
				targetId: conversation.targetId,
				contextId: conversation.contextId,
				payload: {
					direction: "inbound",
					sender: `Phone ending ${conversation.contactLastFour}`,
					recipient: "Business SMS",
					message: {
						id: providerMessageId,
						body: attributedText,
						timestamp: occurredAt,
					},
					phone: {
						threadTarget: conversation.threadTarget,
						displayName: `SMS •••• ${conversation.contactLastFour}`,
					},
					route: { projectSlug: "intake" },
				},
			},
		});
		this.store.markSeen("phone-webhook", providerEventId, "queued");
		this.controlNotifier?.wake();
		this.scheduler?.pump();
		if (committed.relationshipEventQueued && !this.stopped) this.requestFirstContactFlush();
		return "queued";
	}

	prepareConversation(contactAddress) {
		const providerThreadId = stablePrivateKey(
			this.routingKey,
			"phone-provider-thread",
			`${this.config.phone.provider}\0${this.config.phone.senderAddress}\0${contactAddress}`,
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
			label: `Phone •••• ${contactLastFour}`,
		});
		return {
			threadTarget,
			provider: this.config.phone.provider,
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
		if (conversation.status !== "active") throw new Error("phone conversation is not active");
		if (this.store.isPhoneOptedOut(conversation.principalHash)) {
			throw new Error("phone recipient has opted out");
		}
		const contactAddress = openPrivateValue(
			this.routingKey,
			"phone-contact",
			conversation.contactCiphertext,
		);
		return this.provider.sendDirect(contactAddress, text);
	}
}

export function bodyDigest(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function decryptRelayEvent(event, encryptionKey) {
	if (
		typeof event.id !== "string"
		|| !event.id
		|| typeof event.receivedAt !== "string"
		|| typeof event.iv !== "string"
		|| typeof event.ciphertext !== "string"
	) {
		throw new Error("phone relay event is malformed");
	}
	const combined = Buffer.from(event.ciphertext, "base64url");
	if (combined.length <= 16) throw new Error("phone relay ciphertext is malformed");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		Buffer.from(encryptionKey, "base64"),
		Buffer.from(event.iv, "base64url"),
	);
	decipher.setAAD(Buffer.from(event.id));
	decipher.setAuthTag(combined.subarray(combined.length - 16));
	const plaintext = Buffer.concat([
		decipher.update(combined.subarray(0, combined.length - 16)),
		decipher.final(),
	]).toString("utf8");
	const parsed = object(JSON.parse(plaintext));
	if (
		typeof parsed.rawBody !== "string"
		|| typeof parsed.signature !== "string"
		|| typeof parsed.timestamp !== "string"
		|| typeof parsed.receivedAt !== "string"
	) {
		throw new Error("phone relay plaintext is malformed");
	}
	return parsed;
}
