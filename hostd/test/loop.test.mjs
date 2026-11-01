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

function subject(
	fetchImpl = async () => Response.json({ message_id: "LOOP-OUT-1", contact: ALLOWED, text: "hi" }),
	{ seedSms = true } = {},
) {
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
		phone: { provider: "sendly", senderAddress: "+15555550100" },
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
	const sms = new PhoneGateway({ config, store, router, routingKey });
	// The person's one canonical SMS conversation, as the Sendly lane creates it.
	const seed = (contact = ALLOWED) => store.upsertPhoneConversation(sms.prepareConversation(contact));
	const smsConversation = seedSms ? seed() : undefined;
	return {
		config,
		store,
		router,
		routingKey,
		gateway,
		sms,
		seed,
		smsConversation,
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

test("Loop joins the one active SMS conversation context for the same person", () => {
	const loop = subject();
	try {
		const sms = loop.smsConversation;
		assert.equal(loop.gateway.acceptWebhook(inbound()), "queued");
		const stored = loop.store.getEventByProviderMessage("phone", "loop:59C55CE8-41D6-43CC-9116-8CFB2E696D7B");
		const event = { ...stored, payload: JSON.parse(stored.payloadJson) };
		const loopConversation = loop.store.getPhoneConversation(event.payload.phone.threadTarget);
		// Same principal and the same context: one person, one conversation.
		assert.equal(loopConversation.principalHash, sms.principalHash);
		assert.equal(loopConversation.contextId, sms.contextId);
		assert.equal(loopConversation.targetId, sms.targetId);
		assert.equal(event.contextId, sms.contextId);
		// Distinct provider edges, so replies go back over the transport they came in on.
		assert.notEqual(loopConversation.providerThreadId, sms.providerThreadId);
		assert.notEqual(loopConversation.threadTarget, sms.threadTarget);
		assert.equal(loopConversation.provider, "loop");
		assert.equal(sms.provider, "sendly");
		const loopRoute = loop.store.getRoute("phone", loopConversation.providerThreadId);
		const smsRoute = loop.store.getRoute("phone", sms.providerThreadId);
		assert.equal(loopRoute.contextId, smsRoute.contextId);
		assert.equal(loopRoute.projectSlug, smsRoute.projectSlug);
		// One shared context for /app and Zulip projection: every phone event in it.
		const contexts = loop.store.database.prepare(
			"SELECT DISTINCT context_id AS contextId FROM phone_conversations WHERE principal_hash = ?",
		).all(sms.principalHash);
		assert.deepEqual(contexts.map((row) => row.contextId), [sms.contextId]);
		// A second inbound reuses the bound edge without rebinding.
		assert.equal(loop.gateway.acceptWebhook(inbound({ message_id: "M2", webhook_id: "W2" })), "queued");
		assert.equal(loop.gateway.prepareConversation(ALLOWED).contextId, sms.contextId);
	} finally {
		loop.close();
	}
});

test("Loop relationship funnel turns share the SMS funnel without scope conflicts", () => {
	const loop = subject();
	try {
		const sms = loop.smsConversation;
		const loopConversation = loop.store.upsertPhoneConversation(loop.gateway.prepareConversation(ALLOWED));
		const base = { contextId: sms.contextId, source: "phone", principalHash: sms.principalHash, targetId: sms.targetId };
		loop.store.ensureRelationshipFunnel({ ...base, providerThreadId: sms.providerThreadId, observedAt: "2026-10-31T10:00:00.000Z", evidenceId: "sms-1" });
		const funnel = loop.store.ensureRelationshipFunnel({ ...base, providerThreadId: loopConversation.providerThreadId, observedAt: "2026-10-31T10:05:00.000Z", evidenceId: "loop-1" });
		assert.equal(funnel.contextId, sms.contextId);
		// An unbound thread claiming this context is still refused.
		assert.throws(() => loop.store.ensureRelationshipFunnel({ ...base, providerThreadId: "forged-thread", observedAt: "2026-10-31T10:06:00.000Z", evidenceId: "x" }), /relationship_funnel_scope_conflict/);
		assert.throws(() => loop.store.ensureRelationshipFunnel({ ...base, providerThreadId: loopConversation.providerThreadId, principalHash: "other", observedAt: "2026-10-31T10:07:00.000Z", evidenceId: "y" }), /relationship_funnel_scope_conflict/);
	} finally {
		loop.close();
	}
});

test("a direct-agent reply edge must be the same person in the same context", () => {
	const loop = subject();
	try {
		const sms = loop.smsConversation;
		const edge = loop.store.upsertPhoneConversation(loop.gateway.prepareConversation(ALLOWED));
		assert.equal(loop.store.phoneApiReplyEdge(sms, undefined), sms);
		assert.equal(loop.store.phoneApiReplyEdge(sms, edge.threadTarget).threadTarget, edge.threadTarget);
		// Another person's conversation can never become this session's reply edge.
		const strangerSms = loop.seed(STRANGER);
		assert.throws(() => loop.store.phoneApiReplyEdge(sms, strangerSms.threadTarget), /reply edge crossed/);
		assert.throws(() => loop.store.phoneApiReplyEdge(sms, "phone-00000000000000000000"), /reply edge crossed/);
		// Same person, same context, but no router binding: a forged row is not an edge.
		const forged = loop.store.upsertPhoneConversation({
			...edge,
			threadTarget: "phone-11111111111111111111",
			providerThreadId: "forged-loop-thread-without-route",
		});
		assert.equal(forged.contextId, sms.contextId);
		assert.equal(loop.store.getRoute("phone", forged.providerThreadId), undefined);
		assert.throws(() => loop.store.phoneApiReplyEdge(sms, forged.threadTarget), /reply edge crossed/);
		// A route that drifted from the edge row is refused too.
		loop.store.database.prepare("UPDATE routes SET target_id = 'other-target' WHERE provider_thread_id = ?").run(edge.providerThreadId);
		assert.throws(() => loop.store.phoneApiReplyEdge(sms, edge.threadTarget), /reply edge crossed/);
		assert.throws(() => loop.store.queuePhoneApiTurn({
			id: "phone-api:forged",
			providerMessageId: "forged",
			threadTarget: sms.threadTarget,
			replyThreadTarget: strangerSms.threadTarget,
			inboundBody: "x",
			defaultModel: "example-alpha",
		}), /reply edge crossed/);
	} finally {
		loop.close();
	}
});

test("linked funnel scope also proves the owner route", () => {
	const cases = [
		["owner principal", (db, sms) => db.prepare("UPDATE routes SET principal_hash = 'drift' WHERE provider_thread_id = ?").run(sms.providerThreadId)],
		["owner target", (db, sms) => db.prepare("UPDATE routes SET target_id = 'drift' WHERE provider_thread_id = ?").run(sms.providerThreadId)],
		["owner project", (db, sms) => db.prepare("UPDATE routes SET project_slug = 'drift' WHERE provider_thread_id = ?").run(sms.providerThreadId)],
		["linked project", (db, _sms, edge) => db.prepare("UPDATE routes SET project_slug = 'drift' WHERE provider_thread_id = ?").run(edge.providerThreadId)],
		["owner participant", (db, sms) => db.prepare("DELETE FROM route_participants WHERE provider_thread_id = ?").run(sms.providerThreadId)],
		["linked participant", (db, _sms, edge) => db.prepare("DELETE FROM route_participants WHERE provider_thread_id = ?").run(edge.providerThreadId)],
	];
	for (const [name, drift] of cases) {
		const loop = subject();
		try {
			const sms = loop.smsConversation;
			const edge = loop.store.upsertPhoneConversation(loop.gateway.prepareConversation(ALLOWED));
			const base = { contextId: sms.contextId, source: "phone", principalHash: sms.principalHash, targetId: sms.targetId };
			const funnel = loop.store.ensureRelationshipFunnel({ ...base, providerThreadId: sms.providerThreadId, observedAt: "2026-10-31T10:00:00.000Z", evidenceId: "sms-1" });
			assert.equal(loop.store.relationshipThreadInScope(funnel, { ...base, providerThreadId: edge.providerThreadId }), true, name);
			// Simulate storage drift directly; foreign keys would otherwise reject it.
			loop.store.database.exec("PRAGMA foreign_keys = OFF");
			drift(loop.store.database, sms, edge);
			loop.store.database.exec("PRAGMA foreign_keys = ON");
			assert.equal(loop.store.relationshipThreadInScope(funnel, { ...base, providerThreadId: edge.providerThreadId }), false, name);
			assert.throws(() => loop.store.ensureRelationshipFunnel({ ...base, providerThreadId: edge.providerThreadId, observedAt: "2026-10-31T10:05:00.000Z", evidenceId: "loop-1" }), /relationship_funnel_scope_conflict/, name);
		} finally {
			loop.close();
		}
	}
});

test("empty Loop text is quarantined before any linked route is created", () => {
	const none = subject(undefined, { seedSms: false });
	try {
		assert.equal(none.gateway.acceptWebhook(inbound({ text: " ", webhook_id: "e0" })), "quarantined:empty");
	} finally {
		none.close();
	}
	const loop = subject();
	try {
		const routes = () => loop.store.database.prepare("SELECT COUNT(*) AS n FROM routes").get().n;
		const before = routes();
		assert.equal(loop.gateway.acceptWebhook(inbound({ text: "", webhook_id: "e1" })), "quarantined:empty");
		assert.equal(loop.gateway.acceptWebhook(inbound({ text: undefined, webhook_id: "e2" })), "quarantined:empty");
		assert.equal(routes(), before);
		assert.equal(loop.store.database.prepare("SELECT COUNT(*) AS n FROM phone_conversations WHERE provider = 'loop'").get().n, 0);
	} finally {
		loop.close();
	}
});

test("Loop fails closed with zero or multiple canonical SMS conversations", () => {
	const none = subject(undefined, { seedSms: false });
	try {
		assert.equal(none.gateway.acceptWebhook(inbound()), "quarantined:no_canonical_conversation:none");
		assert.equal(none.gateway.acceptWebhook(inbound({ text: "STOP", webhook_id: "stop" })), "quarantined:no_canonical_conversation:none");
		assert.equal(none.eventCount(), 0);
		assert.equal(none.store.getRoute("phone", stablePrivateKey(none.routingKey, "phone-provider-thread", `loop\0${SENDER_ID}\0${ALLOWED}`)), undefined);
		assert.deepEqual(none.counts(), { wakes: 0, pumps: 0 });
	} finally {
		none.close();
	}
	const many = subject();
	try {
		const first = many.smsConversation;
		// A second active SMS conversation for the same person makes the target ambiguous.
		const otherThread = "second-sms-thread";
		const route = many.store.bindRoute({ source: "phone", providerThreadId: otherThread, principalHash: first.principalHash, projectSlug: "intake", targetId: first.targetId, contextId: "ctx-second" });
		many.store.upsertPhoneConversation({ ...first, threadTarget: "phone-ffffffffffffffffffff", providerThreadId: otherThread, contextId: route.contextId });
		assert.equal(many.gateway.acceptWebhook(inbound()), "quarantined:no_canonical_conversation:ambiguous");
		assert.equal(many.eventCount(), 0);
	} finally {
		many.close();
	}
	const mismatch = subject();
	try {
		// Canonical row whose route disagrees on context is refused, not repaired.
		mismatch.store.database.prepare("UPDATE routes SET context_id = 'ctx-drift' WHERE provider_thread_id = ?").run(mismatch.smsConversation.providerThreadId);
		assert.equal(mismatch.gateway.acceptWebhook(inbound()), "quarantined:no_canonical_conversation:mismatch");
		assert.equal(mismatch.eventCount(), 0);
	} finally {
		mismatch.close();
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
		// Configured sender: a missing or empty sender also fails closed.
		assert.equal(loop.gateway.acceptWebhook(inbound({ sender: undefined, webhook_id: "g2" })), "unrelated_sender");
		assert.equal(loop.gateway.acceptWebhook(inbound({ sender: "", webhook_id: "g3" })), "unrelated_sender");
		// Only exact iMessage enters this lane; SMS/RCS/fallback or missing channel is quarantined.
		for (const [index, channel] of [["sms"], ["rcs"], ["iMessage"], [""], [undefined], [["imessage"]]].entries()) {
			assert.equal(loop.gateway.acceptWebhook(inbound({ channel: channel[0], webhook_id: `ch-${index}` })), "quarantined:non_imessage");
		}
		// Any non-empty or malformed attachments field is media.
		for (const [index, attachments] of [[{ url: "x" }], [{}], ["x.jpg"], [""], [42], [true], [false], [[null]]].entries()) {
			assert.equal(loop.gateway.acceptWebhook(inbound({ attachments: attachments[0], webhook_id: `att-${index}` })), "quarantined:non_direct_text", JSON.stringify(attachments));
		}
		assert.throws(() => loop.gateway.acceptWebhook(inbound({ webhook_id: undefined })), /provider identity/);
		assert.equal(loop.eventCount(), 0);
	} finally {
		loop.close();
	}
});

test("Loop text with no attachments or unknown extra fields still queues", () => {
	const loop = subject();
	try {
		for (const [index, attachments] of [[undefined], [null], [[]]].entries()) {
			assert.equal(loop.gateway.acceptWebhook(inbound({ attachments: attachments[0], message_id: `ok-${index}`, webhook_id: `att-ok-${index}` })), "queued");
		}
		// Loop webhooks are forward-compatible: unknown extra fields are ignored.
		assert.equal(loop.gateway.acceptWebhook(inbound({
			future_field: { nested: ["value"] },
			sandbox: true,
			message_id: "ok-extra",
			webhook_id: "att-ok-extra",
		})), "queued");
		assert.equal(loop.eventCount(), 4);
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
		assert.deepEqual(JSON.parse(call.init.body), { contact: ALLOWED, text: "hello", channel: "imessage", sender: SENDER_ID });
		// Every send pins the iMessage channel so Loop cannot fall back to SMS/RCS.
		assert.equal(JSON.parse(call.init.body).channel, "imessage");

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
	const write = async (loopBlock, { dropPhone = false } = {}) => {
		const raw = JSON.parse(await readFile(examplePath, "utf8"));
		raw.loop = loopBlock;
		if (dropPhone) {
			delete raw.phone;
			if (raw.routing) raw.routing.knownPhonePrincipals = [];
		}
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

		assert.ok(config.phone, "example config carries the canonical phone lane");

		await write(valid, { dropPhone: true });
		await assert.rejects(loadConfig(path, environment), /loop requires phone/);
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
