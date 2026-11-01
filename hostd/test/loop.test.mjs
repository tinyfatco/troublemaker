import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { LoopGateway, verifyLoopWebhook } from "../src/loop.mjs";
import { PhoneDeliveryUncertainError, PhoneGateway, PhoneProviderRejectedError } from "../src/phone.mjs";
import { ContextRouter } from "../src/router.mjs";
import { createHostServer } from "../src/server.mjs";
import { contextCapability, sealPrivateValue, stablePrivateKey } from "../src/security.mjs";
import { HostStore } from "../src/store.mjs";

// Synthetic fixture values only; built so no credential-shaped literal is committed.
const synthetic = (name, kind, minimum) => (minimum ? `test-${name}-${kind}-at-least-${minimum}-bytes` : `test-${name}-${kind}`);

const ALLOWED = "+15555550123";
const STRANGER = "+15555550199";
const SECRET = "example-loop-webhook-authorization-value";
const SENDER_ID = "example-sender-id";

function subject(fetchImpl = async () => Response.json({ message_id: "LOOP-OUT-1", contact: ALLOWED, text: "hi" })) {
	const directory = mkdtempSync(join(tmpdir(), "hostd-loop-"));
	const routingKey = Buffer.alloc(32, 7);
	const target = { id: "front-desk", driver: "oci", outboundToken: "example-outbound-token-at-least-32-bytes" };
	const config = {
		loop: {
			provider: "loop",
			senderId: SENDER_ID,
			allowedContacts: [ALLOWED],
			deliveryHolds: [],
			webhookSecret: SECRET,
			apiKey: "example-loop-api-key",
			apiBaseUrl: "https://loop.example",
			ingress: { host: "127.0.0.1", port: 0, path: "/webhooks/loop" },
		},
		routing: { actorTarget: target.id, knownPrincipals: [], knownPhonePrincipals: [] },
		targetsById: new Map([[target.id, target]]),
	};
	const store = new HostStore(join(directory, "state.sqlite"));
	const router = new ContextRouter(config, store, routingKey);
	const calls = [];
	let wakes = 0;
	let pumps = 0;
	const gateway = new LoopGateway({
		config,
		store,
		router,
		routingKey,
		scheduler: { pump: () => { pumps += 1; } },
		controlNotifier: { wake: () => { wakes += 1; } },
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return fetchImpl(url, init);
		},
	});
	return {
		config,
		store,
		router,
		routingKey,
		gateway,
		calls,
		counts: () => ({ wakes, pumps }),
		eventCount: () => store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n,
		close: () => {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

const inbound = (overrides = {}) => ({
	event: "message_inbound",
	contact: ALLOWED,
	text: "hey there",
	message_type: "text",
	message_id: "59C55CE8-41D6-43CC-9116-8CFB2E696D7B",
	webhook_id: "AB5AE733-CCFC-4025-9987-7279B26BE71B",
	sender: SENDER_ID,
	channel: "imessage",
	api_version: "1.0",
	...overrides,
});

test("Loop webhook authorization accepts the exact configured header, raw or Bearer", () => {
	assert.equal(verifyLoopWebhook({ authorization: SECRET }, SECRET), true);
	assert.equal(verifyLoopWebhook({ authorization: `Bearer ${SECRET}` }, SECRET), true);
	assert.equal(verifyLoopWebhook({ authorization: `${SECRET}x` }, SECRET), false);
	assert.equal(verifyLoopWebhook({}, SECRET), false);
	assert.equal(verifyLoopWebhook({ authorization: "short" }, "short"), false);
});

test("allowlisted Loop inbound joins the shared phone pipeline exactly once", () => {
	const loop = subject();
	try {
		assert.equal(loop.gateway.acceptWebhook(inbound()), "queued");
		assert.equal(loop.gateway.acceptWebhook(inbound()), "duplicate");
		assert.equal(loop.eventCount(), 1);
		assert.deepEqual(loop.counts(), { wakes: 1, pumps: 1 });
		const stored = loop.store.getEventByProviderMessage("phone", "loop:59C55CE8-41D6-43CC-9116-8CFB2E696D7B");
		const event = { ...stored, payload: JSON.parse(stored.payloadJson) };
		assert.equal(event.source, "phone");
		assert.equal(event.payload.message.body, "hey there");
		assert.equal(event.payload.phone.provider, "loop");
		assert.match(event.payload.phone.threadTarget, /^phone-[a-f0-9]{20}$/);
		const conversation = loop.store.getPhoneConversation(event.payload.phone.threadTarget);
		assert.equal(conversation.provider, "loop");
		assert.equal(conversation.contactLastFour, "0123");
		// Same person as SMS: the principal is derived from the phone number alone.
		assert.equal(
			conversation.principalHash,
			stablePrivateKey(loop.routingKey, "phone-principal", ALLOWED),
		);
		assert.doesNotMatch(JSON.stringify(event), /5555550123/);
	} finally {
		loop.close();
	}
});

test("Loop and SMS threads for one number share a principal but keep separate conversations", () => {
	const loop = subject();
	try {
		loop.config.phone = { provider: "sendly", senderAddress: "+15555550100" };
		const sms = new PhoneGateway({
			config: loop.config,
			store: loop.store,
			router: loop.router,
			routingKey: loop.routingKey,
		});
		const smsConversation = sms.prepareConversation(ALLOWED);
		const loopConversation = loop.gateway.prepareConversation(ALLOWED);
		assert.equal(smsConversation.principalHash, loopConversation.principalHash);
		assert.notEqual(smsConversation.threadTarget, loopConversation.threadTarget);
		assert.notEqual(smsConversation.providerThreadId, loopConversation.providerThreadId);
	} finally {
		loop.close();
	}
});

test("Loop receipts update outbound status and never wake as inbound", () => {
	const loop = subject();
	try {
		for (const [index, event] of ["message_scheduled", "message_sent", "message_delivered", "message_failed"].entries()) {
			assert.equal(loop.gateway.acceptWebhook(inbound({
				event,
				text: "our own reply text",
				webhook_id: `receipt-${index}`,
			})), "status");
		}
		assert.equal(loop.gateway.acceptWebhook(inbound({ event: "message_reaction", reaction: "like", webhook_id: "r" })), "ignored_event");
		assert.equal(loop.gateway.acceptWebhook(inbound({ event: "inbound_call", webhook_id: "c" })), "ignored_event");
		assert.equal(loop.gateway.acceptWebhook(inbound({ event: "brand_new_event", webhook_id: "n" })), "ignored_event");
		assert.equal(loop.eventCount(), 0);
		assert.deepEqual(loop.counts(), { wakes: 0, pumps: 0 });
	} finally {
		loop.close();
	}
});

test("Loop inbound outside the direct allowlisted text lane is never queued", () => {
	const loop = subject();
	try {
		assert.equal(loop.gateway.acceptWebhook(inbound({ contact: STRANGER, webhook_id: "a" })), "unrelated_contact");
		assert.equal(loop.gateway.acceptWebhook(inbound({ contact: "someone@example.com", webhook_id: "b" })), "quarantined:non_phone_contact");
		assert.equal(loop.gateway.acceptWebhook(inbound({ group: { id: "G1", participants: [ALLOWED, STRANGER] }, webhook_id: "c" })), "quarantined:non_direct_text");
		assert.equal(loop.gateway.acceptWebhook(inbound({ attachments: ["https://cdn.example/x.jpg"], webhook_id: "d" })), "quarantined:non_direct_text");
		assert.equal(loop.gateway.acceptWebhook(inbound({ message_type: "audio", webhook_id: "e" })), "quarantined:non_direct_text");
		assert.equal(loop.gateway.acceptWebhook(inbound({ text: "  ", webhook_id: "f" })), "quarantined:empty");
		assert.equal(loop.gateway.acceptWebhook(inbound({ sender: "someone-else", webhook_id: "g" })), "unrelated_sender");
		assert.throws(() => loop.gateway.acceptWebhook(inbound({ webhook_id: undefined })), /provider identity/);
		assert.equal(loop.eventCount(), 0);
	} finally {
		loop.close();
	}
});

test("Loop STOP opts the person out and blocks sends until START", async () => {
	const loop = subject();
	try {
		assert.equal(loop.gateway.acceptWebhook(inbound({ text: "STOP", webhook_id: "stop" })), "opted_out");
		const conversation = loop.store.getPhoneConversation(loop.gateway.prepareConversation(ALLOWED).threadTarget);
		await assert.rejects(loop.gateway.sendDirect(conversation, "hello"), /opted out/);
		assert.equal(loop.gateway.acceptWebhook(inbound({ text: "start", webhook_id: "start" })), "opted_in");
		const receipt = await loop.gateway.sendDirect(conversation, "hello");
		assert.equal(receipt.providerMessageId, "loop:LOOP-OUT-1");
		assert.equal(loop.eventCount(), 0);
	} finally {
		loop.close();
	}
});

test("Loop send posts the documented request and classifies failures", async () => {
	let mode = "ok";
	const loop = subject(async () => {
		if (mode === "network") throw new Error("socket hang up");
		if (mode === "rejected") return Response.json({ success: false, message: "contact +15555550123 invalid", code: 120 }, { status: 400 });
		if (mode === "no-id") return Response.json({ contact: ALLOWED });
		return Response.json({ message_id: "LOOP-OUT-1", contact: ALLOWED, text: "hello" });
	});
	try {
		loop.gateway.acceptWebhook(inbound());
		const conversation = loop.store.getPhoneConversation(loop.gateway.prepareConversation(ALLOWED).threadTarget);
		const receipt = await loop.gateway.sendDirect(conversation, "hello");
		assert.deepEqual(receipt, { providerMessageId: "loop:LOOP-OUT-1", status: "queued" });
		const call = loop.calls.at(-1);
		assert.equal(call.url, "https://loop.example/api/v1/message/send/");
		assert.equal(call.init.headers.authorization, "example-loop-api-key");
		assert.deepEqual(JSON.parse(call.init.body), { contact: ALLOWED, text: "hello", sender: SENDER_ID });

		mode = "rejected";
		const rejected = await loop.gateway.sendDirect(conversation, "hello").catch((error) => error);
		assert(rejected instanceof PhoneProviderRejectedError);
		assert.doesNotMatch(rejected.message, /5555550123/);
		mode = "network";
		await assert.rejects(loop.gateway.sendDirect(conversation, "hello"), PhoneDeliveryUncertainError);
		mode = "no-id";
		await assert.rejects(loop.gateway.sendDirect(conversation, "hello"), PhoneDeliveryUncertainError);

		loop.config.loop.allowedContacts = [STRANGER];
		mode = "ok";
		const before = loop.calls.length;
		await assert.rejects(loop.gateway.sendDirect(conversation, "hello"), /not allowlisted/);
		assert.equal(loop.calls.length, before);
	} finally {
		loop.close();
	}
});

test("Loop ingress rejects unauthenticated posts and acknowledges authenticated ones", async () => {
	const loop = subject();
	await loop.gateway.start();
	try {
		const { port } = loop.gateway.server.address();
		const url = `http://127.0.0.1:${port}/webhooks/loop`;
		const post = (headers, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
		assert.equal((await post({}, JSON.stringify(inbound()))).status, 401);
		assert.equal((await post({ authorization: "wrong-value-of-sufficient-length" }, JSON.stringify(inbound()))).status, 401);
		assert.equal((await post({ authorization: SECRET }, "{not json")).status, 400);
		const accepted = await post({ authorization: SECRET }, JSON.stringify(inbound()));
		assert.equal(accepted.status, 200);
		assert.deepEqual(await accepted.json(), { ok: true, disposition: "queued" });
		assert.equal((await fetch(`http://127.0.0.1:${port}/other`, { method: "POST" })).status, 404);
		assert.equal(loop.eventCount(), 1);
	} finally {
		await loop.gateway.stop();
		loop.close();
	}
});

test("phone outbound routes Loop conversations to Loop and SMS conversations to SMS", async () => {
	const loop = subject();
	const target = loop.config.targetsById.get("front-desk");
	loop.gateway.acceptWebhook(inbound());
	const loopConversation = loop.store.getPhoneConversation(loop.gateway.prepareConversation(ALLOWED).threadTarget);
	const smsRoute = loop.router.resolvePhone({ providerThreadId: "sms-thread", contactAddress: STRANGER, label: "Phone •••• 0199" });
	const smsConversation = loop.store.upsertPhoneConversation({
		threadTarget: "phone-0123456789abcdef0123",
		provider: "sendly",
		providerThreadId: smsRoute.providerThreadId,
		principalHash: smsRoute.principalHash,
		targetId: smsRoute.targetId,
		contextId: smsRoute.contextId,
		contactCiphertext: sealPrivateValue(loop.routingKey, "phone-contact", STRANGER),
		contactLastFour: "0199",
	});
	const sent = [];
	const fake = (name) => ({
		async sendDirect(conversation, body) {
			sent.push({ name, threadTarget: conversation.threadTarget, body });
			return { providerMessageId: `${name}:${sent.length}`, status: "queued" };
		},
	});
	const config = { ...loop.config, server: {} };
	const server = createHostServer({
		config,
		store: loop.store,
		daemon: { polling: false, controlNotifier: { wake() {} } },
		phoneGateway: fake("sms"),
		loopGateway: fake("loop"),
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = (conversation, key) => fetch(`${base}/v1/outbound/phone`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${contextCapability(target.outboundToken, "outbound", conversation.contextId)}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			context_id: conversation.contextId,
			thread_target: conversation.threadTarget,
			agent_body: `reply ${key}`,
			idempotency_key: key,
		}),
	});
	try {
		const viaLoop = await post(loopConversation, "loop-reply-1");
		assert.equal(viaLoop.status, 200, await viaLoop.clone().text());
		const viaSms = await post(smsConversation, "sms-reply-1");
		assert.equal(viaSms.status, 200, await viaSms.clone().text());
		assert.deepEqual(sent.map((item) => [item.name, item.threadTarget]), [
			["loop", loopConversation.threadTarget],
			["sms", smsConversation.threadTarget],
		]);
		const ledgerRow = loop.store.getEventByProviderMessage("phone_outbound", "loop:1");
		const ledger = { ...ledgerRow, payload: JSON.parse(ledgerRow.payloadJson) };
		assert.equal(ledger.payload.phone.provider, "loop");
		assert.equal(ledger.payload.sender, "Business iMessage");

		config.loop = { ...config.loop, deliveryHolds: [loopConversation.contextId] };
		const held = await post(loopConversation, "loop-reply-held");
		assert.equal(held.status, 403);
	} finally {
		await new Promise((resolvePromise) => server.close(resolvePromise));
		loop.close();
	}
});

test("loop config requires an allowlist, a strong webhook secret, and a free loopback port", async () => {
	const examplePath = fileURLToPath(new URL("../config.zulip.example.json", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "hostd-loop-config-"));
	const path = join(directory, "config.json");
	const environment = {
		TROUBLEMAKER_HOSTD_OPERATOR_TOKEN: "fake-operator-token-at-least-32-bytes",
		ZULIP_HOSTD_ADMIN_API_KEY: "fake-admin-key",
		ZULIP_HOSTD_AGENT_API_KEY: "fake-agent-key",
		ZULIP_HOSTD_PROJECTOR_API_KEY: "fake-projector-key",
		FRONT_DESK_RUNTIME_INBOUND_TOKEN: "fake-inbound-token",
		FRONT_DESK_RUNTIME_OUTBOUND_TOKEN: "fake-outbound-token",
		CONTACT_RELAY_SECRET: synthetic("contact-relay", "secret", 32),
		PHONE_WEBHOOK_SECRET: synthetic("phone-webhook", "secret", 24),
		PHONE_API_KEY: synthetic("phone-api", "key"),
		CLOUDFLARE_WORKERS_AI_API_TOKEN: synthetic("cloudflare-workers-ai", "token"),
		CLOUDFLARE_ACCOUNT_ANALYTICS_TOKEN: synthetic("cloudflare-account-analytics", "token"),
		OPENAI_ORGANIZATION_API_KEY: synthetic("openai-organization-api", "key"),
		EXAMPLE_LOCAL_MODEL_TOKEN: "synthetic-local-gateway-token-at-least-32-bytes",
		LANDING_CHAT_RELAY_TOKEN: synthetic("landing-chat-relay", "token", 32),
		LANDING_CHAT_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
		TROUBLEMAKER_HOSTD_WEB_APP_SECRET: synthetic("web-app", "secret", 32),
		TROUBLEMAKER_HOSTD_MCP_CRAWDAD_ASSERTION_SECRET: synthetic("crawdad-assertion", "secret", 32),
		TROUBLEMAKER_HOSTD_MCP_FAT_ASSERTION_SECRET: synthetic("fat-assertion", "secret", 32),
		ROCKETCHAT_HOSTD_ADMIN_USER_ID: "example-admin-user",
		ROCKETCHAT_HOSTD_ADMIN_TOKEN: "example-admin-token-at-least-32-bytes",
		ROCKETCHAT_CREATE_TOKENS_FOR_USERS_SECRET: "example-create-token-secret-at-least-32-bytes",
		META_CAPI_ACCESS_TOKEN: "synthetic-meta-access-token-at-least-32-bytes",
		META_CAPI_TEST_EVENT_CODE: "TEST12345",
		LOOP_WEBHOOK_AUTHORIZATION: SECRET,
		LOOP_API_KEY: "example-loop-api-key",
	};
	const write = async (loopBlock) => {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.loop = loopBlock;
		await writeFile(path, JSON.stringify(raw));
	};
	const valid = {
		senderId: SENDER_ID,
		allowedContacts: ["+1 (555) 555-0123"],
		webhookSecretEnv: "LOOP_WEBHOOK_AUTHORIZATION",
		apiKeyEnv: "LOOP_API_KEY",
		ingress: { port: 3111 },
	};
	try {
		await write(valid);
		const config = await loadConfig(path, environment);
		assert.deepEqual(config.loop.allowedContacts, [ALLOWED]);
		assert.equal(config.loop.apiBaseUrl, "https://a.loopmessage.com");
		assert.deepEqual(config.loop.ingress, { host: "127.0.0.1", port: 3111, path: "/webhooks/loop" });

		await write({ ...valid, allowedContacts: [] });
		await assert.rejects(loadConfig(path, environment), /allowedContacts/);
		await write(valid);
		await assert.rejects(loadConfig(path, { ...environment, LOOP_WEBHOOK_AUTHORIZATION: "too-short" }), /at least 24/);
		await write({ ...valid, ingress: { host: "0.0.0.0" } });
		await assert.rejects(loadConfig(path, environment), /loopback-only/);
		await write({ ...valid, ingress: { port: 3099 } });
		await assert.rejects(loadConfig(path, environment), /must differ from server.port/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
