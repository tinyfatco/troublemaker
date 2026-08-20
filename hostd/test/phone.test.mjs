import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac } from "node:crypto";
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
}), phoneOverride, firstContact) {
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
		firstContact,
		fetchImpl,
	});
	return {
		directory,
		statePath: join(directory, "state.sqlite"),
		routingKey,
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

function exampleFirstContact(deliver = async ({ eventId }) => ({ receiptId: `receipt:${eventId}` })) {
	return {
		kind: "example_contact",
		pollIntervalSeconds: 60,
		maximumAttempts: 4,
		leaseSeconds: 30,
		retryBaseSeconds: 60,
		retryMaximumSeconds: 60,
		createRecord({ contactAddress, providerMessageId, occurredAt }) {
			return {
				eventId: `phone-contact:${providerMessageId}`,
				payload: {
					occurredAt,
					subjectHash: createHash("sha256")
						.update(contactAddress.replaceAll("+", ""), "utf8")
						.digest("hex"),
				},
			};
		},
		deliver,
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

test("atomically queues one minimized lifecycle event for the first direct contact", async () => {
	const createInputs = [];
	const firstContact = exampleFirstContact();
	const originalCreate = firstContact.createRecord;
	firstContact.createRecord = (input) => {
		createInputs.push(input);
		return originalCreate(input);
	};
	const state = subject(undefined, undefined, firstContact);
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound()), "queued");
		const repeated = inbound({
			id: "provider-message-follow-up",
			text: "Here is unrelated follow-up content that must never enter the lifecycle outbox.",
		});
		repeated.id = "provider-event-follow-up";
		assert.equal(await state.gateway.acceptWebhook(repeated), "queued");

		const outbox = state.store.listRelationshipEventOutbox();
		assert.equal(outbox.length, 1);
		assert.equal(outbox[0].idempotencyKey, "phone-contact:provider-message-inbound");
		assert.match(outbox[0].relationshipKey, /^phone:phone-[a-f0-9]{20}$/);
		const stored = JSON.parse(outbox[0].payloadJson);
		assert.deepEqual(Object.keys(stored).sort(), ["occurredAt", "subjectHash"]);
		assert.match(stored.subjectHash, /^[a-f0-9]{64}$/);
		const serialized = JSON.stringify(outbox);
		assert.equal(serialized.includes(CONTACT_NUMBER), false);
		assert.equal(serialized.includes(CONTACT_NUMBER.slice(1)), false);
		assert.equal(serialized.includes("Could you help"), false);
		assert.equal(serialized.includes("unrelated follow-up"), false);
		assert.equal(serialized.includes("client_ip_address"), false);
		assert.equal(serialized.includes("client_user_agent"), false);
		assert.deepEqual(Object.keys(createInputs[0]).sort(), [
			"contactAddress",
			"occurredAt",
			"provider",
			"providerEventId",
			"providerMessageId",
			"threadTarget",
		]);
		assert.equal(createInputs.length, 2, "adapter preparation is harmless; the durable uniqueness decision is transactional");
	} finally {
		state.close();
	}
});

test("rolls relationship, inbound event, and first-contact outbox back together after a crash", async () => {
	const state = subject(undefined, undefined, exampleFirstContact());
	try {
		state.store.database.exec(`
			CREATE TRIGGER example_first_contact_crash
			BEFORE INSERT ON relationship_event_outbox
			BEGIN
				SELECT RAISE(ABORT, 'simulated first-contact crash');
			END;
		`);
		await assert.rejects(
			state.gateway.acceptWebhook(inbound()),
			/simulated first-contact crash/,
		);
		assert.equal(state.store.listRetryableEvents().length, 0);
		assert.equal(state.store.listRelationshipEventOutbox().length, 0);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM phone_conversations").get().count, 0);

		state.store.database.exec("DROP TRIGGER example_first_contact_crash");
		assert.equal(await state.gateway.acceptWebhook(inbound()), "queued");
		assert.equal(state.store.listRetryableEvents().length, 1);
		assert.equal(state.store.listRelationshipEventOutbox().length, 1);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM phone_conversations").get().count, 1);
	} finally {
		state.close();
	}
});

test("reconciles a provider failure after restart with the original event ID", async () => {
	const attempted = [];
	const state = subject(undefined, undefined, exampleFirstContact(async ({ eventId }) => {
		attempted.push(eventId);
		throw new Error("example provider returned HTTP 503");
	}));
	let reopened;
	try {
		await state.gateway.acceptWebhook(inbound());
		await state.gateway.flushFirstContacts();
		assert.deepEqual(attempted, ["phone-contact:provider-message-inbound"]);
		assert.equal(state.store.listRelationshipEventOutbox()[0].status, "retry");
		state.store.database.prepare(`
			UPDATE relationship_event_outbox SET available_at = '2000-01-01T00:00:00.000Z'
		`).run();
		state.store.close();

		const store = new HostStore(state.statePath);
		const router = new ContextRouter(state.config, store, state.routingKey);
		const recovered = exampleFirstContact(async ({ eventId }) => {
			attempted.push(eventId);
			return { receiptId: "provider-receipt-example" };
		});
		reopened = new PhoneGateway({
			config: state.config,
			store,
			router,
			routingKey: state.routingKey,
			firstContact: recovered,
		});
		await reopened.flushFirstContacts();
		assert.deepEqual(attempted, [
			"phone-contact:provider-message-inbound",
			"phone-contact:provider-message-inbound",
		]);
		assert.equal(store.listRelationshipEventOutbox()[0].status, "delivered");
		assert.equal(store.listRelationshipEventOutbox()[0].receiptId, "provider-receipt-example");
		store.close();
	} finally {
		if (!reopened) state.store.close();
		rmSync(state.directory, { recursive: true, force: true });
	}
});

test("replays an expired delivery lease with the same event ID after an ambiguous crash", async () => {
	const delivered = [];
	const firstContact = exampleFirstContact(async ({ eventId }) => {
		delivered.push(eventId);
		return { receiptId: "provider-receipt-after-crash" };
	});
	const state = subject(undefined, undefined, firstContact);
	try {
		await state.gateway.acceptWebhook(inbound());
		const claimed = state.store.claimRelationshipEventOutbox({
			kind: firstContact.kind,
			maximumAttempts: firstContact.maximumAttempts,
			leaseSeconds: firstContact.leaseSeconds,
		});
		assert.equal(claimed.idempotencyKey, "phone-contact:provider-message-inbound");
		state.store.database.prepare(`
			UPDATE relationship_event_outbox SET lease_expires_at = '2000-01-01T00:00:00.000Z'
		`).run();

		await state.gateway.flushFirstContacts();
		assert.deepEqual(delivered, ["phone-contact:provider-message-inbound"]);
		const completed = state.store.listRelationshipEventOutbox()[0];
		assert.equal(completed.status, "delivered");
		assert.equal(completed.attempts, 2);
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

test("never creates first-contact records for unrelated, status, opt-out, group, media, or unknown events", async () => {
	const cases = [
		{
			name: "unrelated sender",
			payload: inbound({ to: "+15555550999" }),
			disposition: "unrelated_sender",
		},
		{
			name: "delivery status",
			payload: inbound({ from: BUSINESS_NUMBER, to: CONTACT_NUMBER, status: "delivered" }),
			type: "message.delivered",
			disposition: "status",
		},
		{
			name: "opt-out",
			payload: inbound({ text: "STOP" }),
			type: "message.opt_out",
			disposition: "opted_out",
		},
		{
			name: "group",
			payload: inbound({ metadata: { group: true, participants: [CONTACT_NUMBER, "+15555550124"] } }),
			disposition: "quarantined:non_direct_text",
		},
		{
			name: "media",
			payload: inbound({ media_urls: ["https://media.example/file.png"] }),
			disposition: "quarantined:non_direct_text",
		},
		{
			name: "unknown event",
			payload: inbound(),
			type: "message.updated",
			disposition: "ignored_event",
		},
	];
	for (const [index, candidate] of cases.entries()) {
		candidate.payload.id = `provider-event-excluded-${index}`;
		candidate.payload.data.object.id = `provider-message-excluded-${index}`;
		if (candidate.type) candidate.payload.type = candidate.type;
		const state = subject(undefined, undefined, exampleFirstContact());
		try {
			assert.equal(
				await state.gateway.acceptWebhook(candidate.payload),
				candidate.disposition,
				candidate.name,
			);
			assert.equal(state.store.listRelationshipEventOutbox().length, 0, candidate.name);
		} finally {
			state.close();
		}
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
