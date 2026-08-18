import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
} from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INBOUND_CHARACTERS = 2_000;
const MAX_OUTBOUND_CHARACTERS = 10_000;

function object(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedText(value, maximum, label) {
	if (typeof value !== "string") throw new Error(`${label} is required`);
	const cleaned = value
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim();
	if (!cleaned || cleaned.length > maximum) throw new Error(`${label} is invalid`);
	return cleaned;
}

function relayKey(encoded) {
	const key = Buffer.from(encoded, "base64");
	if (key.length !== 32) throw new Error("website chat relay key must contain 32 bytes");
	return key;
}

export function encryptWebChatRelayPayload(payload, encryptionKey, envelopeId) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", relayKey(encryptionKey), iv);
	cipher.setAAD(Buffer.from(envelopeId));
	const encrypted = Buffer.concat([
		cipher.update(JSON.stringify(payload), "utf8"),
		cipher.final(),
	]);
	return {
		iv: iv.toString("base64url"),
		ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64url"),
	};
}

export function decryptWebChatRelayPayload(event, encryptionKey) {
	if (
		typeof event.id !== "string"
		|| !event.id
		|| typeof event.receivedAt !== "string"
		|| typeof event.iv !== "string"
		|| typeof event.ciphertext !== "string"
	) {
		throw new Error("website chat relay event is malformed");
	}
	const combined = Buffer.from(event.ciphertext, "base64url");
	if (combined.length <= 16) throw new Error("website chat relay ciphertext is malformed");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		relayKey(encryptionKey),
		Buffer.from(event.iv, "base64url"),
	);
	decipher.setAAD(Buffer.from(event.id));
	decipher.setAuthTag(combined.subarray(combined.length - 16));
	return object(JSON.parse(Buffer.concat([
		decipher.update(combined.subarray(0, combined.length - 16)),
		decipher.final(),
	]).toString("utf8")));
}

function visitorLabel(sessionId) {
	return `Website visitor ${sessionId.replaceAll("-", "").slice(-4).toUpperCase()}`;
}

export class WebChatGateway {
	constructor({
		config,
		store,
		router,
		scheduler,
		controlNotifier,
		fetchImpl = fetch,
	}) {
		this.config = config;
		this.store = store;
		this.router = router;
		this.scheduler = scheduler;
		this.controlNotifier = controlNotifier;
		this.fetch = fetchImpl;
		this.timer = null;
		this.currentPump = null;
		this.stopped = true;
	}

	async start() {
		if (!this.config.webChat || !this.stopped) return;
		this.stopped = false;
		await this.pump();
		this.timer = setInterval(
			() => void this.pump(),
			this.config.webChat.relay.pollIntervalSeconds * 1000,
		);
		this.timer.unref();
	}

	async stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.currentPump;
	}

	wake() {
		if (!this.stopped) queueMicrotask(() => void this.pump());
	}

	async pump() {
		if (this.stopped || this.currentPump) return this.currentPump;
		this.currentPump = this.pumpInner();
		try {
			await this.currentPump;
			this.store.setMeta("web-chat:last_poll_error", "");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.setMeta("web-chat:last_poll_error", message.slice(0, 1000));
			if (!this.stopped) console.error("troublemaker-hostd: website chat relay failed:", message);
		} finally {
			this.currentPump = null;
		}
	}

	async pumpInner() {
		await this.pollInbound();
		await this.flushOutbound();
	}

	async pollInbound() {
		const relay = this.config.webChat.relay;
		const response = await this.fetch(`${relay.url}/pull`, {
			method: "POST",
			headers: { authorization: `Bearer ${relay.token}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`website chat relay pull returned HTTP ${response.status}`);
		const result = object(await response.json());
		if (typeof result.claimId !== "string" || !UUID.test(result.claimId) || !Array.isArray(result.events)) {
			throw new Error("website chat relay pull response is malformed");
		}
		const acknowledged = [];
		for (const rawEvent of result.events) {
			const event = object(rawEvent);
			try {
				await this.acceptRelayEvent(event);
				acknowledged.push(event.id);
			} catch (error) {
				console.error(
					`troublemaker-hostd: website chat relay event ${String(event.id || "unknown")} held:`,
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
			body: JSON.stringify({ claimId: result.claimId, ids: acknowledged }),
			signal: AbortSignal.timeout(30_000),
		});
		if (!ack.ok) throw new Error(`website chat relay ack returned HTTP ${ack.status}`);
	}

	async acceptRelayEvent(event) {
		const relay = this.config.webChat.relay;
		const payload = decryptWebChatRelayPayload(event, relay.encryptionKey);
		const relayReceivedAt = Date.parse(event.receivedAt);
		const payloadCreatedAt = Date.parse(payload.createdAt);
		if (
			typeof payload.sessionId !== "string" || !UUID.test(payload.sessionId)
			|| typeof payload.messageId !== "string" || payload.messageId !== event.id
			|| typeof payload.createdAt !== "string"
			|| !Number.isFinite(relayReceivedAt)
			|| !Number.isFinite(payloadCreatedAt)
			|| payloadCreatedAt !== relayReceivedAt
		) {
			throw new Error("website chat relay payload binding is invalid");
		}
		const body = boundedText(payload.body, MAX_INBOUND_CHARACTERS, "website chat body");
		if (this.store.hasSeen("web-chat-relay", event.id)) return "duplicate";

		const conversation = this.ensureConversation(payload.sessionId);
		this.store.upsertEventWithControlNotification({
			id: `web_chat:${payload.messageId}`,
			source: "web_chat",
			providerMessageId: payload.messageId,
			providerThreadId: conversation.providerThreadId,
			principalHash: conversation.principalHash,
			targetId: conversation.targetId,
			contextId: conversation.contextId,
			payload: {
				direction: "inbound",
				sender: conversation.displayLabel,
				recipient: "TinyFat.com",
				message: {
					id: payload.messageId,
					body,
					timestamp: payload.createdAt,
				},
				webChat: {
					sessionId: payload.sessionId,
					displayName: conversation.displayLabel,
				},
				route: { projectSlug: "website-chat" },
			},
		});
		this.store.markSeen("web-chat-relay", event.id, "queued");
		this.controlNotifier?.wake();
		this.scheduler?.pump();
		return "queued";
	}

	ensureConversation(sessionId) {
		const displayLabel = visitorLabel(sessionId);
		const route = this.router.resolveWebChat({ sessionId, label: displayLabel });
		return this.store.upsertWebChatConversation({
			sessionId,
			providerThreadId: sessionId,
			principalHash: route.principalHash,
			targetId: route.targetId,
			contextId: route.contextId,
			displayLabel,
		});
	}

	queueOperatorMessage(contextId, providerMessageId, body) {
		const conversation = this.store.getWebChatConversationByContext(contextId);
		if (!conversation || conversation.status !== "active") return false;
		const cleanBody = boundedText(body, MAX_OUTBOUND_CHARACTERS, "website chat reply");
		this.store.queueWebChatOutbox({
			externalId: `zulip:${providerMessageId}`,
			sessionId: conversation.sessionId,
			contextId,
			body: cleanBody,
		});
		this.wake();
		return true;
	}

	async flushOutbound() {
		for (let count = 0; count < 25; count++) {
			const delivery = this.store.claimWebChatOutbox(10);
			if (!delivery) break;
			try {
				const createdAt = new Date().toISOString();
				const envelope = encryptWebChatRelayPayload({
					sessionId: delivery.sessionId,
					messageId: delivery.externalId,
					body: delivery.body,
					createdAt,
				}, this.config.webChat.relay.encryptionKey, delivery.externalId);
				const response = await this.fetch(`${this.config.webChat.relay.url}/publish`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.config.webChat.relay.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						id: delivery.externalId,
						sessionId: delivery.sessionId,
						...envelope,
					}),
					signal: AbortSignal.timeout(30_000),
				});
				if (!response.ok) throw new Error(`website chat relay publish returned HTTP ${response.status}`);
				this.store.completeWebChatOutbox(delivery.externalId);
			} catch (error) {
				this.store.failWebChatOutbox(
					delivery.externalId,
					error instanceof Error ? error.message : String(error),
					10,
				);
			}
		}
	}
}
