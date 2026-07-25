import assert from "node:assert/strict";
import { createCipheriv, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PhoneGateway, verifySendlyWebhook } from "../src/phone.mjs";
import { ContextRouter } from "../src/router.mjs";
import { HostStore } from "../src/store.mjs";

const BUSINESS_NUMBER = "+15555550100";
const CONTACT_NUMBER = "+15555550123";

function subject(fetchImpl = async () => Response.json({
	id: "provider-message-outbound",
	status: "queued",
	message_format: "sms",
}), phoneOverride) {
	const directory = mkdtempSync(join(tmpdir(), "hostd-phone-"));
	const routingKey = Buffer.alloc(32, 7);
	const target = { id: "front-desk", driver: "oci" };
	const config = {
		phone: phoneOverride ?? {
			provider: "sendly",
			directOnly: true,
			senderAddress: BUSINESS_NUMBER,
			webhookSecret: "example-webhook-secret-at-least-24-bytes",
			apiKey: "example-api-key",
			apiBaseUrl: "https://provider.example/api/v1",
			ingress: {
				host: "127.0.0.1",
				port: 3100,
				path: "/webhooks/sendly",
			},
		},
		routing: {
			actorTarget: target.id,
			knownPrincipals: [],
		},
		targetsById: new Map([[target.id, target]]),
	};
	const store = new HostStore(join(directory, "state.sqlite"));
	const router = new ContextRouter(config, store, routingKey);
	let schedulerPumps = 0;
	let notifierWakes = 0;
	const gateway = new PhoneGateway({
		config,
		store,
		router,
		routingKey,
		scheduler: { pump: () => { schedulerPumps += 1; } },
		controlNotifier: { wake: () => { notifierWakes += 1; } },
		fetchImpl,
	});
	return {
		directory,
		config,
		store,
		gateway,
		counts: () => ({ schedulerPumps, notifierWakes }),
		close: () => {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function encryptedRelayEvent(payload, secret, encryptionKey, receivedAt) {
	const rawBody = JSON.stringify(payload);
	const timestamp = String(Math.floor(Date.parse(receivedAt) / 1000));
	const signature = `sha256=${createHmac("sha256", secret)
		.update(`${timestamp}.${rawBody}`)
		.digest("hex")}`;
	const id = "message.received:provider-event-relay";
	const iv = Buffer.alloc(12, 3);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "base64"), iv);
	cipher.setAAD(Buffer.from(id));
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify({ rawBody, signature, timestamp, receivedAt }), "utf8"),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return {
		id,
		receivedAt,
		iv: iv.toString("base64url"),
		ciphertext: ciphertext.toString("base64url"),
	};
}

function inbound(overrides = {}) {
	return {
		id: "provider-event-inbound",
		type: "message.received",
		data: {
			object: {
				id: "provider-message-inbound",
				from: CONTACT_NUMBER,
				to: BUSINESS_NUMBER,
				text: "Could you help with an estimate?",
				message_format: "sms",
				metadata: {},
				...overrides,
			},
		},
	};
}

test("verifies the timestamped raw-body webhook signature and rejects stale delivery", () => {
	const rawBody = JSON.stringify(inbound());
	const timestamp = String(Math.floor(Date.now() / 1000));
	const secret = "example-webhook-secret-at-least-24-bytes";
	const signature = `sha256=${createHmac("sha256", secret)
		.update(`${timestamp}.${rawBody}`)
		.digest("hex")}`;
	assert.equal(verifySendlyWebhook(rawBody, {
		"x-sendly-timestamp": timestamp,
		"x-sendly-signature": signature,
	}, secret), true);
	assert.equal(verifySendlyWebhook(rawBody, {
		"x-sendly-timestamp": "1",
		"x-sendly-signature": signature,
	}, secret), false);
});

test("routes one direct text into an isolated context without exposing phone numbers", async () => {
	const state = subject();
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound()), "queued");
		const events = state.store.listRetryableEvents();
		assert.equal(events.length, 1);
		assert.equal(events[0].source, "phone");
		assert.match(events[0].contextId, /^front-desk:[a-f0-9]{24}:intake$/);
		const payload = JSON.parse(events[0].payloadJson);
		assert.match(payload.phone.threadTarget, /^phone-[a-f0-9]{20}$/);
		assert.equal(payload.message.body, "Could you help with an estimate?");
		assert.equal(JSON.stringify(payload).includes(BUSINESS_NUMBER), false);
		assert.equal(JSON.stringify(payload).includes(CONTACT_NUMBER), false);
		assert.deepEqual(state.counts(), { schedulerPumps: 1, notifierWakes: 1 });
		assert.equal(await state.gateway.acceptWebhook(inbound()), "duplicate");
		assert.equal(state.store.listRetryableEvents().length, 1);
	} finally {
		state.close();
	}
});

test("quarantines group and media evidence before creating a route", async () => {
	const state = subject();
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound({
			metadata: { group: true, participants: ["+15555550124"] },
		})), "quarantined:non_direct_text");
		assert.equal(state.store.listRetryableEvents().length, 0);
		assert.equal(state.store.listContexts().length, 0);
	} finally {
		state.close();
	}
});

test("accepts provider-inferred two-party markers but keeps independent group evidence quarantined", async () => {
	const inferredDirect = subject();
	try {
		assert.equal(await inferredDirect.gateway.acceptWebhook(inbound({
			metadata: {
				group: true,
				groupInferred: true,
				groupKey: "inferred-two-party-example",
			},
		})), "queued");
		assert.equal(inferredDirect.store.listRetryableEvents().length, 1);
		assert.equal(inferredDirect.store.database.prepare(`
			SELECT COUNT(*) AS count FROM phone_conversations
		`).get().count, 1);
	} finally {
		inferredDirect.close();
	}

	const inferredWithRoster = subject();
	try {
		assert.equal(await inferredWithRoster.gateway.acceptWebhook(inbound({
			metadata: {
				group: true,
				groupInferred: true,
				groupKey: "inferred-with-roster-example",
				participants: [CONTACT_NUMBER, BUSINESS_NUMBER, "+15555550124"],
			},
		})), "quarantined:non_direct_text");
		assert.equal(inferredWithRoster.store.listRetryableEvents().length, 0);
		assert.equal(inferredWithRoster.store.listContexts().length, 0);
	} finally {
		inferredWithRoster.close();
	}
});

test("host-owned direct delivery resolves the encrypted contact and never accepts recipients", async () => {
	let providerBody;
	const state = subject(async (_url, init) => {
		providerBody = JSON.parse(init.body);
		return Response.json({
			id: "provider-message-outbound",
			status: "queued",
			message_format: "sms",
		});
	});
	try {
		await state.gateway.acceptWebhook(inbound());
		const event = state.store.listRetryableEvents()[0];
		const payload = JSON.parse(event.payloadJson);
		const conversation = state.store.getPhoneConversation(payload.phone.threadTarget);
		const receipt = await state.gateway.sendDirect(conversation, "Yes — what are you building?");
		assert.equal(receipt.providerMessageId, "provider-message-outbound");
		assert.deepEqual(providerBody, {
			to: CONTACT_NUMBER,
			from: BUSINESS_NUMBER,
			text: "Yes — what are you building?",
			messageType: "transactional",
		});
	} finally {
		state.close();
	}
});

test("opt-out state blocks agent delivery without generating a harness reply", async () => {
	const state = subject();
	try {
		const optedOut = inbound({ text: "STOP" });
		optedOut.id = "provider-event-opt-out";
		optedOut.type = "message.opt_out";
		optedOut.data.object.id = "provider-message-opt-out";
		assert.equal(await state.gateway.acceptWebhook(optedOut), "opted_out");
		assert.equal(state.store.listRetryableEvents().length, 0);
		const { threadTarget } = state.store.database.prepare(`
			SELECT thread_target AS threadTarget FROM phone_conversations LIMIT 1
		`).get();
		const conversation = state.store.getPhoneConversation(threadTarget);
		await assert.rejects(
			() => state.gateway.sendDirect(conversation, "This must not be sent."),
			/opted out/,
		);
	} finally {
		state.close();
	}
});

test("polls encrypted edge relay events without opening an ingress listener", async () => {
	const webhookSecret = "example-webhook-secret-at-least-24-bytes";
	const encryptionKey = Buffer.alloc(32, 8).toString("base64");
	const receivedAt = new Date().toISOString();
	const payload = inbound();
	payload.id = "provider-event-relay";
	const event = encryptedRelayEvent(payload, webhookSecret, encryptionKey, receivedAt);
	let acknowledged;
	const phone = {
		provider: "sendly",
		directOnly: true,
		senderAddress: BUSINESS_NUMBER,
		webhookSecret,
		apiKey: "example-api-key",
		apiBaseUrl: "https://provider.example/api/v1",
		relay: {
			url: "https://relay.example/api/v2/hostd/phone",
			token: "example-relay-token",
			encryptionKey,
			pollIntervalSeconds: 60,
		},
	};
	const state = subject(async (url, init) => {
		if (String(url).endsWith("/pull")) return Response.json({ events: [event] });
		if (String(url).endsWith("/ack")) {
			acknowledged = JSON.parse(init.body).ids;
			return Response.json({ ok: true });
		}
		throw new Error(`unexpected URL ${url}`);
	}, phone);
	try {
		await state.gateway.start();
		assert.equal(state.gateway.server, null);
		assert.deepEqual(acknowledged, [event.id]);
		assert.equal(state.store.listRetryableEvents().length, 1);
		assert.equal(state.store.getMeta("phone:last_poll_error"), "");
	} finally {
		await state.gateway.stop();
		state.close();
	}
});
