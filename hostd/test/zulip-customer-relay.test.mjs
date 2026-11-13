import assert from "node:assert/strict";
import test from "node:test";
import { ZulipGateway } from "../src/zulip-gateway.mjs";

const RELAY = { user_id: 29, full_name: "Text rider", email: "text-rider-bot@example.test", is_bot: true };
const AGENT = { user_id: 9, full_name: "Operator", email: "operator-bot@example.test", is_bot: true };
const PROJECTOR = { user_id: 10, full_name: "PEDICAB", email: "pedicab-bot@example.test", is_bot: true };
const PEDRO = { user_id: 12, full_name: "Pedro", email: "pedro-bot@example.test", is_bot: true };
const CONTEXT = "operator:abc123";
const CONVERSATION = {
	threadTarget: "phone-thread", providerThreadId: "pt-1", principalHash: "abc123",
	targetId: "operator", contextId: CONTEXT, contactLastFour: "8113", status: "active",
};

function mention(user) {
	return `<span class="user-mention" data-user-id="${user.user_id}">@${user.full_name}</span>`;
}

function harness({ attentionMode = "all", sendError, conversation = CONVERSATION } = {}) {
	const posts = [];
	const sends = [];
	const events = [];
	const ledger = [];
	const outbox = new Map();
	let wakes = 0;
	const raw = new Map();
	const store = {
		getZulipBindingByChannel: (id) => id === 77 ? { channelId: 77, contextId: CONTEXT, attentionMode } : null,
		getEventByProviderMessage: () => null,
		getMeta: (key) => key === `work-phone:${CONTEXT}` && conversation ? conversation.threadTarget : null,
		getPhoneConversation: () => conversation,
		getLatestPhoneConversationForContext: () => conversation,
		startOutbox({ idempotencyKey }) {
			if (outbox.has(idempotencyKey)) return { status: outbox.get(idempotencyKey), claimed: false };
			outbox.set(idempotencyKey, "sending");
			return { status: "sending", claimed: true };
		},
		completePhoneOutboxWithLedger(key, id, event) { outbox.set(key, "sent"); ledger.push(event); },
		failOutbox(key) { outbox.set(key, "failed"); },
		markOutboxUncertain(key) { outbox.set(key, "uncertain"); },
		upsertEvent(event) { events.push(event); return { awarenessSequence: events.length }; },
	};
	const provisioner = {
		async identities() {
			return { agent: AGENT, projector: PROJECTOR, members: [PEDRO], observers: [RELAY] };
		},
		async request(path, options = {}) {
			if (path === "register") return { queue_id: "q", last_event_id: 0 };
			if (path.startsWith("messages/")) return { message: { raw_content: raw.get(Number(path.split("/")[1])) } };
			if (path === "users/5") return { user: { user_id: 5, is_bot: false } };
			if (path === "messages" && options.method === "POST") {
				posts.push({ auth: options.auth, content: options.form.get("content") });
				return { id: 1 };
			}
			throw new Error(`unexpected ${path}`);
		},
	};
	const phoneGateway = {
		async sendDirect(conv, body) {
			if (sendError) throw sendError;
			sends.push({ conv, body });
			return { providerMessageId: `sms-${sends.length}` };
		},
		controlNotifier: { wake() { wakes += 1; } },
	};
	const gateway = new ZulipGateway({
		config: { zulip: { customerRelayEmail: RELAY.email } },
		store, provisioner, scheduler: { pump() {} }, phoneGateway,
	});
	const message = (id, html, rawContent, sender = 5) => {
		raw.set(id, rawContent);
		return { id, stream_id: 77, sender_id: sender, sender_full_name: "Alex", type: "stream", content: html };
	};
	return { gateway, posts, sends, events, ledger, outbox, message, wakes: () => wakes };
}

async function started(options) {
	const h = harness(options);
	h.gateway.pollLoop = async () => {};
	await h.gateway.start();
	return h;
}

test("@Text rider from staff sends one SMS through host phone, ledgers it and wakes PEDICAB projection", async () => {
	const h = await started();
	await h.gateway.ingestMessage(h.message(100, `<p>${mention(RELAY)} Ready to ride?</p>`, "@**Text rider** Ready to ride?"));
	assert.equal(h.sends.length, 1);
	assert.equal(h.sends[0].body, "Ready to ride?");
	assert.equal(h.sends[0].conv.threadTarget, "phone-thread");
	assert.equal(h.ledger.length, 1);
	assert.equal(h.ledger[0].source, "phone_outbound");
	assert.equal(h.ledger[0].payload.sender, "Alex via Text rider");
	assert.equal(h.outbox.get("zulip-relay:100"), "sent");
	assert.equal(h.wakes(), 1);
	assert.equal(h.posts.length, 0);
	// Operator still gets awareness of the human message (its adapter marks it as addressed elsewhere).
	assert.equal(h.events.length, 1);
	assert.equal(h.events[0].payload.message.sender_is_bot, false);
});

test("redelivered relay message is not texted twice", async () => {
	const h = await started();
	const msg = h.message(101, `<p>${mention(RELAY)} hi</p>`, "@**Text rider|29** hi");
	await h.gateway.ingestMessage(msg);
	await h.gateway.ingestMessage(msg);
	assert.equal(h.sends.length, 1);
	assert.equal(h.sends[0].body, "hi");
});

test("bots mentioning Text rider never text the customer", async () => {
	const h = await started();
	await h.gateway.ingestMessage(h.message(102, `<p>${mention(RELAY)} hi</p>`, "@**Text rider** hi", AGENT.user_id));
	await h.gateway.ingestMessage(h.message(103, `<p>${mention(RELAY)} hi</p>`, "@**Text rider** hi", PEDRO.user_id));
	assert.equal(h.sends.length, 0);
	assert.equal(h.events.length, 1, "Pedro's message is still queued for Operator awareness");
	assert.equal(h.events[0].payload.message.sender_is_bot, true);
});

test("empty relay or missing rider phone posts a projector notice instead of sending", async () => {
	const h = await started();
	await h.gateway.ingestMessage(h.message(104, `<p>${mention(RELAY)}</p>`, "@**Text rider**"));
	assert.equal(h.sends.length, 0);
	assert.match(h.posts[0].content, /Nothing sent/);
	assert.equal(h.posts[0].auth, "projector");
	const none = await started({ conversation: null });
	await none.gateway.ingestMessage(none.message(105, `<p>${mention(RELAY)} hi</p>`, "@**Text rider** hi"));
	assert.equal(none.sends.length, 0);
	assert.match(none.posts[0].content, /no rider phone/);
});

test("provider failure is reported in-channel and marked failed", async () => {
	const h = await started({ sendError: new Error("provider rejected") });
	await h.gateway.ingestMessage(h.message(106, `<p>${mention(RELAY)} hi</p>`, "@**Text rider** hi"));
	assert.equal(h.outbox.get("zulip-relay:106"), "failed");
	assert.match(h.posts[0].content, /Not sent: provider rejected/);
});

test("mentions-only attention is judged from the agent's mention, not the admin's is_mentioned flag", async () => {
	const h = await started({ attentionMode: "mentions-only" });
	const toAgent = h.message(107, `<p>${mention(AGENT)} status?</p>`, "@**Operator** status?");
	toAgent.is_mentioned = false;
	await h.gateway.ingestMessage(toAgent);
	const toAdmin = h.message(108, `<p><span class="user-mention" data-user-id="5">@Alex</span> fyi</p>`, "@**Alex** fyi", 30);
	toAdmin.is_mentioned = true;
	await h.gateway.ingestMessage(toAdmin);
	assert.deepEqual(h.events.map((e) => e.providerMessageId), ["107"]);
});
