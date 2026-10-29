import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MetaContactExporter } from "../src/meta-contact.mjs";
import { PhoneGateway, verifySendlyWebhook } from "../src/phone.mjs";
import { ContextRouter } from "../src/router.mjs";
import { HostStore } from "../src/store.mjs";

const BUSINESS_NUMBER = "+15555550100";
const CONTACT_NUMBER = "+15555550123";
const EXAMPLE_CAMPAIGN_PREFILL = "Example campaign inquiry";
const TINYFAT_CAMPAIGN_PREFILL = "Get me a TinyFat website!";
const LOCAL_CATALOG = [
	{ id: "example-alpha", name: "Example Alpha", about: "Synthetic first catalog entry." },
	{ id: "example-beta", name: "Example Beta", about: "Synthetic second catalog entry." },
];

function subject(fetchImpl = async () => Response.json({
	id: "provider-message-outbound",
	status: "queued",
	message_format: "sms",
}), phoneOverride, firstContact, openAiGateway, localChatGateway) {
	const directory = mkdtempSync(join(tmpdir(), "hostd-phone-"));
	const routingKey = Buffer.alloc(32, 7);
	const target = {
		id: "front-desk",
		driver: "oci",
		outboundToken: "example-outbound-token-at-least-32-bytes",
	};
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
		openAi: phoneOverride?.apiAgent ? { requestTimeoutMs: 5_000 } : undefined,
		routing: {
			actorTarget: target.id,
			knownPrincipals: [],
			knownPhonePrincipals: phoneOverride?.apiAgent
				? [{ phone: CONTACT_NUMBER, targetId: target.id }]
				: [],
		},
		targetsById: new Map([[target.id, target]]),
	};
	const store = new HostStore(join(directory, "state.sqlite"));
	if (phoneOverride?.apiAgent) {
		store.setPhoneModelCatalogCache(JSON.stringify({ data: LOCAL_CATALOG }));
	}
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
		openAiGateway,
		localChatGateway,
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
		resolveAttribution({ messageText, provider, providerMessageId }) {
			if (messageText.normalize("NFC").trim() !== EXAMPLE_CAMPAIGN_PREFILL) return undefined;
			return {
				messageText,
				claim: {
					claimKey: `example:${createHash("sha256")
						.update(`${provider}\0${providerMessageId}`, "utf8")
						.digest("hex")}`,
					source: "example",
					campaignId: "campaign-example",
				},
			};
		},
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

function attributedInbound(overrides = {}) {
	return inbound({
		text: EXAMPLE_CAMPAIGN_PREFILL,
		...overrides,
	});
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

function apiPhone() {
	return {
		provider: "sendly",
		directOnly: true,
		deliveryHolds: [],
		senderAddress: BUSINESS_NUMBER,
		webhookSecret: "example-webhook-secret-at-least-24-bytes",
		apiKey: "example-api-key",
		apiBaseUrl: "https://provider.example/api/v1",
		ingress: {
			host: "127.0.0.1",
			port: 3100,
			path: "/webhooks/sendly",
		},
		apiAgent: {
			featureSenders: [CONTACT_NUMBER],
			advisorModel: "gpt-5.6-luna",
			defaultModel: "example-alpha",
			localCatalog: {
				baseUrl: "http://127.0.0.1:19043/v1",
				apiKey: "synthetic-local-gateway-token-at-least-32-bytes",
				maximumOutputTokens: 150,
				repetitionPenalty: 1.1,
				requestTimeoutMs: 60_000,
				maximumRequestBytes: 64 * 1024,
				maximumCatalogBytes: 64 * 1024,
				maximumModels: 16,
			},
			maximumHistoryMessages: 24,
			maximumReplyCharacters: 1200,
			maximumOutputTokens: 512,
			catalogTtlSeconds: 60,
			configNudgeTimeoutMs: 1000,
			pollIntervalSeconds: 1,
		},
	};
}

function localApiPhone() {
	return apiPhone();
}

function localGateway(complete = async () => "Synthetic local reply.") {
	return {
		async listModels() { return LOCAL_CATALOG; },
		async complete(modelId, messages, signal, options) {
			return complete(modelId, messages, signal, options);
		},
	};
}

function modelResponse(output, model = "gpt-5.6-luna") {
	const encoder = new TextEncoder();
	const body = [
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: output })}\n\n`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				model,
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		})}\n\n`,
		"data: [DONE]\n\n",
	].join("");
	return new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	}), { status: 200, headers: { "content-type": "text/event-stream" } });
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
		assert.match(events[0].contextId, /^front-desk:[a-f0-9]{24}:relationship-operator$/);
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

test("a non-feature sender keeps the regular website-bot path unchanged", async () => {
	let modelCalls = 0;
	let providerCalls = 0;
	const state = subject(
		async () => {
			providerCalls += 1;
			throw new Error("direct provider must not be called");
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone() {
				modelCalls += 1;
				throw new Error("direct model must not be called");
			},
		},
	);
	try {
		const regular = inbound({ from: "+15555550999", text: "/chat" });
		assert.equal(await state.gateway.acceptWebhook(regular), "queued");
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM principals").get().count, 1);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM routes").get().count, 1);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM phone_conversations").get().count, 1);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM phone_api_sessions").get().count, 0);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM phone_api_turns").get().count, 0);
		assert.equal(modelCalls, 0);
		assert.equal(providerCalls, 0);
		assert.deepEqual(state.counts(), { schedulerPumps: 1, notifierWakes: 1 });
	} finally {
		state.close();
	}
});

test("the exact feature flag grants a host-direct reply without clearing a runtime hold", async () => {
	let modelCalls = 0;
	let providerCalls = 0;
	const state = subject(
		async () => {
			providerCalls += 1;
			return Response.json({ id: "provider-feature-reply", status: "queued" });
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _contextId, model) {
				modelCalls += 1;
				return modelResponse(JSON.stringify({
					reply: "Configuration mode is active.",
					selected_model: null,
				}), model);
			},
		},
		localGateway(),
	);
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		const conversation = state.store.database.prepare(`
			SELECT context_id AS contextId FROM phone_conversations LIMIT 1
		`).get();
		state.config.phone.deliveryHolds.push(conversation.contextId);
		state.gateway.stopped = false;
		await state.gateway.flushApiAgent();
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-message-inbound").status, "completed");
		assert.deepEqual(state.config.phone.deliveryHolds, [conversation.contextId]);
		assert.equal(modelCalls, 1);
		assert.equal(providerCalls, 2);
	} finally {
		state.close();
	}
});

test("config reads the authenticated catalog and chat sends the selected catalog ID", async () => {
	const advisorCalls = [];
	const localCalls = [];
	const providerSends = [];
	const state = subject(
		async (url, options) => {
			assert.equal(url, "https://provider.example/api/v1/messages");
			providerSends.push(JSON.parse(options.body));
			return Response.json({ id: `provider-direct-${providerSends.length}`, status: "queued" });
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(target, contextId, model, maximumOutputTokens, body) {
				advisorCalls.push({ target, contextId, model, maximumOutputTokens, body });
				return modelResponse(JSON.stringify({
					reply: "Need a hand choosing?",
				}), model);
			},
		},
		localGateway(async (modelId, messages) => {
			localCalls.push({ modelId, messages });
			return "Synthetic catalog chat reply.";
		}),
	);
	try {
		const configure = inbound({ text: "/config" });
		assert.equal(await state.gateway.acceptWebhook(configure), "phone_api_queued");
		assert.equal(await state.gateway.acceptWebhook(configure), "duplicate");
		state.gateway.stopped = false;
		await state.gateway.flushApiAgent();

		const conversation = state.store.database.prepare(`
			SELECT thread_target AS threadTarget FROM phone_conversations LIMIT 1
		`).get();
		const initialSession = state.store.getPhoneApiSession(conversation.threadTarget);
		assert.equal(initialSession.selectedModel, "example-alpha");
		assert.equal(initialSession.modelGeneration, 1);
		assert.equal(advisorCalls.length, 1);
		assert.equal(advisorCalls[0].model, "gpt-5.6-luna");
		assert.equal(advisorCalls[0].maximumOutputTokens, 128);
		assert.deepEqual(advisorCalls[0].body.tools, []);
		assert.equal(advisorCalls[0].body.tool_choice, "none");
		assert.match(advisorCalls[0].body.input[0].content[0].text, /optional follow-up/);
		assert.match(providerSends[0].text, /^Config mode\. Current: Example Alpha\./);
		assert.match(providerSends[0].text, /Example Alpha \(current\): Synthetic first catalog entry/);
		assert.match(providerSends[0].text, /Example Beta: Synthetic second catalog entry/);
		assert.equal(providerSends[1].text, "Need a hand choosing?");

		const select = inbound({ id: "provider-message-select", text: "eXaMpLe BeTa" });
		select.id = "provider-event-select";
		assert.equal(await state.gateway.acceptWebhook(select), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const configuredSession = state.store.getPhoneApiSession(conversation.threadTarget);
		assert.equal(configuredSession.selectedModel, "example-beta");
		assert.equal(configuredSession.modelGeneration, 2);
		assert.equal(advisorCalls.length, 1);
		assert.equal(providerSends[2].text, "Switched to Example Beta. /chat to talk.");

		const chat = inbound({ id: "provider-message-chat", text: "/chat" });
		chat.id = "provider-event-chat";
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(advisorCalls.length, 1);
		assert.equal(localCalls.length, 0);
		assert.equal(providerSends[3].text, "Chat mode is on with Example Beta.");
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-message-chat").mode, "chat");
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-message-chat").isModeCommand, 1);
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-message-chat").model, "example-beta");
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-message-chat").modelGeneration, 2);

		const message = inbound({ id: "provider-message-chat-text", text: "Say hello from the selected model." });
		message.id = "provider-event-chat-text";
		assert.equal(await state.gateway.acceptWebhook(message), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(localCalls.length, 1);
		assert.equal(localCalls[0].modelId, "example-beta");
		assert.deepEqual(localCalls[0].messages, [{
			role: "user",
			content: "Say hello from the selected model.",
		}]);
		assert.equal(providerSends[4].text, "Synthetic catalog chat reply.");
	} finally {
		state.close();
	}
});

test("config help uses a stale last-good catalog and precedes a failed Luna nudge", async () => {
	const order = [];
	const providerSends = [];
	let advisorCalls = 0;
	const state = subject(
		async (_url, options) => {
			order.push("provider");
			providerSends.push(JSON.parse(options.body));
			return Response.json({ id: `provider-stale-${providerSends.length}`, status: "queued" });
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone() {
				advisorCalls += 1;
				order.push("advisor");
				throw new Error("synthetic Luna outage");
			},
		},
		{
			async listModels() {
				order.push("refresh");
				throw new Error("synthetic tunnel outage");
			},
			async complete() { throw new Error("chat completion must not run"); },
		},
	);
	try {
		state.store.setPhoneModelCatalogCache(
			JSON.stringify({ data: LOCAL_CATALOG }),
			"2000-01-01T00:00:00.000Z",
		);
		state.gateway.stopped = false;
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(providerSends.length, 1);
		assert.match(providerSends[0].text, /^Config mode\. Current: Example Alpha\./);
		assert.ok(order.indexOf("provider") < order.indexOf("advisor"));
		assert.equal(advisorCalls, 1);
		const help = state.store.getPhoneApiTurn("phone-api:provider-message-inbound");
		const nudge = state.store.getPhoneApiTurn("phone-api:provider-message-inbound:config-nudge");
		assert.equal(help.status, "completed");
		assert.equal(nudge.status, "completed");
		assert.equal(nudge.providerStatus, "skipped");
		assert.equal(nudge.providerReplyMessageId, null);
	} finally {
		state.close();
	}
});

test("config help reaches the provider before a bounded Luna timeout and the timeout stays silent", async () => {
	let firstProviderDelay;
	let providerCalls = 0;
	let startedAt;
	const state = subject(
		async () => {
			providerCalls += 1;
			if (firstProviderDelay === undefined) firstProviderDelay = performance.now() - startedAt;
			return Response.json({ id: `provider-timeout-${providerCalls}`, status: "queued" });
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _context, _model, _tokens, _body, signal) {
				await new Promise((resolve, reject) => {
					const hold = setTimeout(resolve, 1000);
					signal.addEventListener("abort", () => {
						clearTimeout(hold);
						reject(signal.reason);
					}, { once: true });
				});
			},
		},
		localGateway(),
	);
	try {
		state.config.phone.apiAgent.configNudgeTimeoutMs = 25;
		state.gateway.stopped = false;
		startedAt = performance.now();
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.ok(firstProviderDelay < 200);
		assert.equal(providerCalls, 1);
		const nudge = state.store.getPhoneApiTurn("phone-api:provider-message-inbound:config-nudge");
		assert.equal(nudge.status, "completed");
		assert.equal(nudge.providerStatus, "skipped");
		assert.equal(nudge.lastError, null);
	} finally {
		state.close();
	}
});

test("new config input preempts an optional Luna nudge before an exact switch", async () => {
	let releaseHelp;
	const helpSent = new Promise((resolve) => { releaseHelp = resolve; });
	let releaseNudgeStart;
	const nudgeStarted = new Promise((resolve) => { releaseNudgeStart = resolve; });
	let providerCalls = 0;
	let advisorCalls = 0;
	const state = subject(
		async () => {
			providerCalls += 1;
			if (providerCalls === 1) releaseHelp();
			return Response.json({ id: `provider-preempt-${providerCalls}`, status: "queued" });
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _context, _model, _tokens, _body, signal) {
				advisorCalls += 1;
				releaseNudgeStart();
				await new Promise((resolve, reject) => {
					const hold = setTimeout(resolve, 1000);
					signal.addEventListener("abort", () => {
						clearTimeout(hold);
						reject(signal.reason);
					}, { once: true });
				});
			},
		},
		localGateway(),
	);
	try {
		state.config.phone.apiAgent.configNudgeTimeoutMs = 1000;
		state.gateway.stopped = false;
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		await helpSent;
		await nudgeStarted;
		const select = inbound({ id: "provider-preempt-select", text: "Example Beta" });
		select.id = "provider-preempt-select-event";
		assert.equal(await state.gateway.acceptWebhook(select), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(advisorCalls, 1);
		assert.equal(providerCalls, 2);
		const nudge = state.store.getPhoneApiTurn("phone-api:provider-message-inbound:config-nudge");
		assert.equal(nudge.status, "completed");
		assert.equal(nudge.providerStatus, "skipped");
		assert.equal(state.store.getPhoneApiSession(nudge.threadTarget).selectedModel, "example-beta");
	} finally {
		state.close();
	}
});

test("only a fuzzy config request invokes Luna and a selected result gets a deterministic confirmation", async () => {
	const advisorCalls = [];
	const providerSends = [];
	const state = subject(
		async (_url, options) => {
			providerSends.push(JSON.parse(options.body));
			return Response.json({ id: `provider-fuzzy-${providerSends.length}`, status: "queued" });
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _context, model, _tokens, body) {
				advisorCalls.push(body);
				return advisorCalls.length === 1
					? modelResponse(JSON.stringify({ reply: "Tell me what style you want." }), model)
					: modelResponse(JSON.stringify({
						reply: "Example Beta sounds right (current).",
						selected_model: "example-beta",
					}), model);
			},
		},
		localGateway(),
	);
	try {
		state.gateway.stopped = false;
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const fuzzy = inbound({ id: "provider-fuzzy-choice", text: "I want the second synthetic personality" });
		fuzzy.id = "provider-fuzzy-event";
		assert.equal(await state.gateway.acceptWebhook(fuzzy), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(advisorCalls.length, 2);
		assert.equal(advisorCalls[1].text.format.name, "phone_model_advice");
		assert.equal(providerSends.at(-1).text, "Switched to Example Beta. /chat to talk.");
		const session = state.store.database.prepare(`
			SELECT selected_model AS selectedModel, model_generation AS modelGeneration
			FROM phone_api_sessions LIMIT 1
		`).get();
		assert.deepEqual({ ...session }, { selectedModel: "example-beta", modelGeneration: 2 });
	} finally {
		state.close();
	}
});

test("a model switch starts a new chat-history thread with no system prompt", async () => {
	let advisorCalls = 0;
	const localCalls = [];
	const providerSends = [];
	const state = subject(
		async (_url, options) => {
			providerSends.push(JSON.parse(options.body));
			return Response.json({ id: `provider-thread-${providerSends.length}`, status: "queued" });
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _contextId, model) {
				advisorCalls += 1;
				return modelResponse(JSON.stringify({ reply: "Choose a model when ready." }), model);
			},
		},
		localGateway(async (modelId, messages) => {
			localCalls.push({ modelId, messages });
			return `reply-${localCalls.length}`;
		}),
	);
	try {
		state.gateway.stopped = false;
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const selectBeta = inbound({ id: "provider-select-beta", text: "example-beta" });
		selectBeta.id = "event-select-beta";
		assert.equal(await state.gateway.acceptWebhook(selectBeta), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const first = inbound({ id: "provider-good-one", text: "/chat" });
		first.id = "event-good-one";
		assert.equal(await state.gateway.acceptWebhook(first), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(localCalls.length, 0);
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-good-one").mode, "chat");
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-good-one").isModeCommand, 1);
		const beta = inbound({ id: "provider-beta-chat", text: "Start the first selected thread." });
		beta.id = "event-beta-chat";
		assert.equal(await state.gateway.acceptWebhook(beta), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const second = inbound({ id: "provider-good-two", text: "Keep this in the first selected thread." });
		second.id = "event-good-two";
		assert.equal(await state.gateway.acceptWebhook(second), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(localCalls[1].modelId, "example-beta");
		assert.deepEqual(localCalls[1].messages.map((message) => message.role), ["user", "assistant", "user"]);
		assert.equal(localCalls[1].messages.some((message) => message.role === "system"), false);
		assert.equal(localCalls[1].messages.some((message) => message.content.includes("/chat")), false);

		const configureAlpha = inbound({ id: "provider-config-alpha", text: "/config" });
		configureAlpha.id = "event-config-alpha";
		assert.equal(await state.gateway.acceptWebhook(configureAlpha), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const selectAlpha = inbound({ id: "provider-select-alpha", text: "Example Alpha" });
		selectAlpha.id = "event-select-alpha";
		assert.equal(await state.gateway.acceptWebhook(selectAlpha), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const alpha = inbound({ id: "provider-alpha-chat", text: "/chat" });
		alpha.id = "event-alpha-chat";
		assert.equal(await state.gateway.acceptWebhook(alpha), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(localCalls.length, 2);
		const alphaText = inbound({ id: "provider-alpha-text", text: "Start the second selected thread." });
		alphaText.id = "event-alpha-text";
		assert.equal(await state.gateway.acceptWebhook(alphaText), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(localCalls[2].modelId, "example-alpha");
		assert.deepEqual(localCalls[2].messages, [{
			role: "user",
			content: "Start the second selected thread.",
		}]);
		const session = state.store.database.prepare(`
			SELECT selected_model AS selectedModel, model_generation AS modelGeneration
			FROM phone_api_sessions LIMIT 1
		`).get();
		assert.deepEqual({ ...session }, { selectedModel: "example-alpha", modelGeneration: 3 });
		assert.equal(advisorCalls, 2);
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-good-two").modelGeneration, 2);
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-alpha-chat").mode, "chat");
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-alpha-chat").isModeCommand, 1);
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-alpha-text").modelGeneration, 3);
	} finally {
		state.close();
	}
});

test("a definitive provider content rejection gets one carrier-safe local rewrite", async () => {
	const providerSends = [];
	const localCalls = [];
	const state = subject(
		async (_url, options) => {
			providerSends.push(JSON.parse(options.body));
			if (providerSends.length === 5) {
				return Response.json({
					error: "compliance_blocked",
					message: "Synthetic restricted content.",
					code: "SHAFT_CONTENT_DETECTED",
					category: "alcohol",
					matchedTerms: ["synthetic-term"],
					suggestion: "Rewrite without the restricted topic.",
				}, { status: 400 });
			}
			return Response.json({ id: `provider-compliance-${providerSends.length}`, status: "queued" });
		},
		localApiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _contextId, model) {
				return modelResponse(JSON.stringify({
					reply: "Example Local is selected for chat.",
					selected_model: "example-beta",
				}), model);
			},
		},
		{
			async listModels() { return LOCAL_CATALOG; },
			async complete(modelId, messages) {
				localCalls.push({ modelId, messages });
				return localCalls.length === 1
					? "A synthetic first draft rejected by the provider."
					: "A playful carrier-safe replacement.";
			},
		},
	);
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		state.gateway.stopped = false;
		await state.gateway.flushApiAgent();
		const select = inbound({ id: "provider-message-compliance-select", text: "example-beta" });
		select.id = "provider-event-compliance-select";
		assert.equal(await state.gateway.acceptWebhook(select), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const chat = inbound({ id: "provider-message-compliance", text: "/chat" });
		chat.id = "provider-event-compliance";
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(localCalls.length, 0);
		const message = inbound({ id: "provider-message-compliance-text", text: "Generate the synthetic rejected draft." });
		message.id = "provider-event-compliance-text";
		assert.equal(await state.gateway.acceptWebhook(message), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(providerSends.length, 6);
		assert.equal(localCalls.length, 2);
		assert.doesNotMatch(localCalls[0].messages[0].content, /carrier-safe|provider rejected the prior draft/i);
		assert.match(localCalls[1].messages.at(-1).content, /Rewrite your answer.*carrier-safe SMS/i);
		assert.equal(localCalls[1].messages.at(-1).role, "user");
		assert.match(localCalls[1].messages.at(-1).content, /Rewrite your answer.*carrier-safe SMS/i);
		assert.equal(providerSends[4].text, "A synthetic first draft rejected by the provider.");
		assert.equal(providerSends[5].text, "A playful carrier-safe replacement.");
		const turn = state.store.getPhoneApiTurn("phone-api:provider-message-compliance-text");
		assert.equal(turn.status, "completed");
		assert.equal(turn.replyBody, "A playful carrier-safe replacement.");
		assert.equal(turn.providerReplyMessageId, "provider-compliance-6");
		assert.equal(turn.lastError, null);
	} finally {
		state.close();
	}
});

test("a second provider content rejection fails closed without a third send", async () => {
	let providerCalls = 0;
	let localCalls = 0;
	const state = subject(
		async () => {
			providerCalls += 1;
			if (providerCalls <= 4) {
				return Response.json({ id: `provider-setup-${providerCalls}`, status: "queued" });
			}
			return Response.json({
				error: "compliance_blocked",
				message: "Synthetic restricted content.",
				code: "SHAFT_CONTENT_DETECTED",
				category: "alcohol",
				matchedTerms: ["synthetic-term"],
				suggestion: "Rewrite without the restricted topic.",
			}, { status: 400 });
		},
		localApiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _contextId, model) {
				return modelResponse(JSON.stringify({
					reply: "Example Local is selected for chat.",
					selected_model: "example-beta",
				}), model);
			},
		},
		{
			async listModels() { return LOCAL_CATALOG; },
			async complete() {
				localCalls += 1;
				return `Synthetic local draft ${localCalls}.`;
			},
		},
	);
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		state.gateway.stopped = false;
		await state.gateway.flushApiAgent();
		const select = inbound({ id: "provider-message-compliance-twice-select", text: "Example Beta" });
		select.id = "provider-event-compliance-twice-select";
		assert.equal(await state.gateway.acceptWebhook(select), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const chat = inbound({ id: "provider-message-compliance-twice", text: "/chat" });
		chat.id = "provider-event-compliance-twice";
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(localCalls, 0);
		const message = inbound({ id: "provider-message-compliance-twice-text", text: "Generate another synthetic rejected draft." });
		message.id = "provider-event-compliance-twice-text";
		assert.equal(await state.gateway.acceptWebhook(message), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(providerCalls, 6);
		assert.equal(localCalls, 2);
		const turn = state.store.getPhoneApiTurn("phone-api:provider-message-compliance-twice-text");
		assert.equal(turn.status, "failed");
		assert.match(turn.lastError, /compliance_blocked\/SHAFT_CONTENT_DETECTED\/alcohol/);
		await state.gateway.flushApiAgent();
		assert.equal(providerCalls, 6);
	} finally {
		state.close();
	}
});

test("an ambiguous direct provider result is never retried", async () => {
	let providerCalls = 0;
	const state = subject(
		async () => {
			providerCalls += 1;
			if (providerCalls === 1) {
				return Response.json({ id: "provider-command", status: "queued" });
			}
			throw new TypeError("synthetic connection loss");
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _contextId, model) {
				return modelResponse("This reply has one uncertain provider attempt.", model);
			},
		},
		localGateway(async () => "This reply has one uncertain provider attempt."),
	);
	try {
		const chat = inbound({ text: "/chat" });
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		state.gateway.stopped = false;
		await state.gateway.flushApiAgent();
		assert.equal(state.store.getPhoneApiTurn("phone-api:provider-message-inbound").status, "completed");
		const message = inbound({ id: "provider-message-uncertain", text: "Generate one uncertain reply." });
		message.id = "provider-event-uncertain";
		assert.equal(await state.gateway.acceptWebhook(message), "phone_api_queued");
		await state.gateway.flushApiAgent();
		const turn = state.store.getPhoneApiTurn("phone-api:provider-message-uncertain");
		assert.equal(turn.status, "uncertain");
		assert.equal(providerCalls, 2);
		await state.gateway.flushApiAgent();
		assert.equal(providerCalls, 2);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM outbox").get().count, 0);
	} finally {
		state.close();
	}
});

test("atomically queues one minimized lifecycle event only with verified attribution", async () => {
	const createInputs = [];
	const firstContact = exampleFirstContact();
	const originalCreate = firstContact.createRecord;
	firstContact.createRecord = (input) => {
		createInputs.push(input);
		return originalCreate(input);
	};
	const state = subject(undefined, undefined, firstContact);
	try {
		assert.equal(await state.gateway.acceptWebhook(attributedInbound()), "queued");
		assert.equal(await state.gateway.acceptWebhook(attributedInbound()), "duplicate");
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
		assert.equal(serialized.includes(EXAMPLE_CAMPAIGN_PREFILL), false);
		assert.equal(serialized.includes("unrelated follow-up"), false);
		assert.equal(serialized.includes("client_ip_address"), false);
		assert.equal(serialized.includes("client_user_agent"), false);
		assert.deepEqual(state.store.listRelationshipAttributions().map((claim) => ({
			claimKey: claim.claimKey,
			source: claim.source,
			campaignId: claim.campaignId,
		})), [{
			claimKey: `example:${createHash("sha256")
				.update("sendly\0provider-message-inbound", "utf8")
				.digest("hex")}`,
			source: "example",
			campaignId: "campaign-example",
		}]);
		assert.deepEqual(Object.keys(createInputs[0]).sort(), [
			"attribution",
			"contactAddress",
			"occurredAt",
			"provider",
			"providerEventId",
			"providerMessageId",
			"threadTarget",
		]);
		assert.equal(createInputs.length, 1);
		const phonePayload = JSON.parse(state.store.listRetryableEvents()[0].payloadJson);
		assert.equal(phonePayload.message.body, EXAMPLE_CAMPAIGN_PREFILL);
	} finally {
		state.close();
	}
});

test("unmarked first contacts never enter the lifecycle outbox and block later attribution", async () => {
	const state = subject(undefined, undefined, exampleFirstContact());
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound()), "queued");
		assert.equal(state.store.listRelationshipEventOutbox().length, 0);
		assert.equal(state.store.listRelationshipAttributions().length, 0);
		const markedFollowUp = attributedInbound({ id: "provider-message-marked-follow-up" });
		markedFollowUp.id = "provider-event-marked-follow-up";
		assert.equal(await state.gateway.acceptWebhook(markedFollowUp), "queued");
		assert.equal(state.store.listRelationshipEventOutbox().length, 0);
		assert.equal(state.store.listRelationshipAttributions().length, 0);
	} finally {
		state.close();
	}
});

test("a replayed provider message cannot create another relationship conversion", async () => {
	const state = subject(undefined, undefined, exampleFirstContact());
	try {
		assert.equal(await state.gateway.acceptWebhook(attributedInbound()), "queued");
		const replay = attributedInbound({
			from: "+15555550124",
		});
		replay.id = "provider-event-replayed-claim";
		assert.equal(await state.gateway.acceptWebhook(replay), "queued");
		assert.equal(state.store.listRelationshipEventOutbox().length, 1);
		assert.equal(state.store.listRelationshipAttributions().length, 1);
		assert.equal(state.store.listRetryableEvents().length, 1);
	} finally {
		state.close();
	}
});

test("an opt-out-created relationship cannot later be backfilled as an attributed first contact", async () => {
	const state = subject(undefined, undefined, exampleFirstContact());
	try {
		const optOut = inbound({ text: "STOP", id: "provider-message-opt-out-first" });
		optOut.id = "provider-event-opt-out-first";
		optOut.type = "message.opt_out";
		assert.equal(await state.gateway.acceptWebhook(optOut), "opted_out");
		const marked = attributedInbound({ id: "provider-message-after-opt-out" });
		marked.id = "provider-event-after-opt-out";
		assert.equal(await state.gateway.acceptWebhook(marked), "queued");
		assert.equal(state.store.listRelationshipEventOutbox().length, 0);
		assert.equal(state.store.listRelationshipAttributions().length, 0);
	} finally {
		state.close();
	}
});

function metaConfig(overrides = {}) {
	const { attribution: attributionOverrides = {}, ...configOverrides } = overrides;
	return {
		datasetId: "123456789012345",
		accessToken: "synthetic-access-token-at-least-32-bytes",
		attribution: {
			enabled: true,
			source: "meta",
			campaignId: "111111111111111111",
			exactPrefill: TINYFAT_CAMPAIGN_PREFILL,
			...attributionOverrides,
		},
		testEventCode: "TEST12345",
		apiBaseUrl: "https://graph.facebook.com",
		apiVersion: "v25.0",
		pollIntervalSeconds: 60,
		maximumAttempts: 4,
		leaseSeconds: 30,
		retryBaseSeconds: 60,
		retryMaximumSeconds: 60,
		requestTimeoutMs: 15_000,
		...configOverrides,
	};
}

test("persists the inquiry intent and reconciles only the minimized first-contact payload", async () => {
	const requests = [];
	const exporter = new MetaContactExporter(metaConfig(), {
		fetchImpl: async (url, init) => {
			requests.push({ url: String(url), body: JSON.parse(init.body) });
			return Response.json({ events_received: 1, fbtrace_id: "synthetic_trace_123" });
		},
	});
	const state = subject(undefined, undefined, exporter);
	try {
		const first = inbound({
			created_at: "2026-08-19T12:34:56.000Z",
			text: TINYFAT_CAMPAIGN_PREFILL,
			client_ip_address: "192.0.2.10",
			client_user_agent: "private-user-agent",
			conversation: "private conversation content",
			form: { content: "private form content" },
		});
		assert.equal(await state.gateway.acceptWebhook(first), "queued");
		const followUp = inbound({
			id: "provider-message-follow-up",
			created_at: "2026-08-19T12:35:56.000Z",
			text: TINYFAT_CAMPAIGN_PREFILL,
		});
		followUp.id = "provider-event-follow-up";
		assert.equal(await state.gateway.acceptWebhook(followUp), "queued");
		const replay = inbound({
			from: "+15555550124",
			created_at: "2026-08-19T12:36:56.000Z",
			text: TINYFAT_CAMPAIGN_PREFILL,
		});
		replay.id = "provider-event-replayed-prefill";
		assert.equal(await state.gateway.acceptWebhook(replay), "queued");

		const outbox = state.store.listRelationshipEventOutbox();
		assert.equal(outbox.length, 1);
		assert.equal(outbox[0].status, "pending");
		const payload = JSON.parse(outbox[0].payloadJson);
		assert.deepEqual(Object.keys(payload).sort(), [
			"action_source",
			"event_id",
			"event_name",
			"event_time",
			"user_data",
		]);
		assert.deepEqual(Object.keys(payload.user_data), ["ph"]);
		assert.deepEqual(state.store.listRelationshipAttributions().map((claim) => ({
			source: claim.source,
			campaignId: claim.campaignId,
		})), [{ source: "meta", campaignId: "111111111111111111" }]);
		const stored = JSON.stringify(outbox);
		for (const forbidden of [
			CONTACT_NUMBER,
			CONTACT_NUMBER.slice(1),
			TINYFAT_CAMPAIGN_PREFILL,
			"192.0.2.10",
			"private-user-agent",
			"private conversation",
			"private form",
		]) assert.equal(stored.includes(forbidden), false, forbidden);
		const phoneEvents = state.store.listRetryableEvents().map((event) => JSON.parse(event.payloadJson));
		assert.equal(phoneEvents[0].message.body, TINYFAT_CAMPAIGN_PREFILL);
		assert.equal(phoneEvents[0].operatorIntent, "tinyfat_website_inquiry");
		assert.equal(phoneEvents[1].operatorIntent, undefined, "follow-ups never regain inquiry intent");

		await state.gateway.flushFirstContacts();
		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, "https://graph.facebook.com/v25.0/123456789012345/events");
		assert.deepEqual(requests[0].body.data, [payload]);
		assert.equal(state.store.listRelationshipEventOutbox()[0].status, "delivered");
	} finally {
		state.close();
	}
});

test("unmarked, edited, disabled, and non-Meta first contacts never enter the conversion outbox", async () => {
	for (const [name, text, overrides] of [
		["unmarked organic", "Manual text without attribution", {}],
		["edited punctuation", "Get me a TinyFat website", {}],
		["edited suffix", "Get me a TinyFat website! Please", {}],
		["disabled allowlist", TINYFAT_CAMPAIGN_PREFILL, { attribution: { enabled: false } }],
		["non-Meta source", TINYFAT_CAMPAIGN_PREFILL, { attribution: { source: "organic" } }],
	]) {
		const state = subject(undefined, undefined, new MetaContactExporter(metaConfig(overrides)));
		try {
			assert.equal(await state.gateway.acceptWebhook(inbound({ text })), "queued", name);
			assert.equal(state.store.listRelationshipEventOutbox().length, 0, name);
			assert.equal(state.store.listRelationshipAttributions().length, 0, name);
			const payload = JSON.parse(state.store.listRetryableEvents()[0].payloadJson);
			assert.equal(payload.operatorIntent, undefined, name);
		} finally {
			state.close();
		}
	}
});

test("an organic first contact permanently blocks later exact-prefill Meta attribution", async () => {
	const state = subject(undefined, undefined, new MetaContactExporter(metaConfig()));
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "An ordinary organic inquiry" })), "queued");
		const later = inbound({
			id: "provider-message-later-prefill",
			text: TINYFAT_CAMPAIGN_PREFILL,
		});
		later.id = "provider-event-later-prefill";
		assert.equal(await state.gateway.acceptWebhook(later), "queued");
		assert.equal(state.store.listRelationshipEventOutbox().length, 0);
		assert.equal(state.store.listRelationshipAttributions().length, 0);
		for (const event of state.store.listRetryableEvents()) {
			assert.equal(JSON.parse(event.payloadJson).operatorIntent, undefined);
		}
	} finally {
		state.close();
	}
});

test("never replays a queued Test Events conversion under live delivery configuration", async () => {
	const testExporter = new MetaContactExporter(metaConfig());
	const state = subject(undefined, undefined, testExporter);
	const liveRequests = [];
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound({
			text: TINYFAT_CAMPAIGN_PREFILL,
		})), "queued");
		const liveExporter = new MetaContactExporter(metaConfig({ testEventCode: undefined }), {
			fetchImpl: async (...request) => {
				liveRequests.push(request);
				return Response.json({ events_received: 1 });
			},
		});
		assert.notEqual(liveExporter.kind, testExporter.kind);
		const restarted = new PhoneGateway({
			config: state.config,
			store: state.store,
			router: state.gateway.router,
			routingKey: state.routingKey,
			firstContact: liveExporter,
		});
		await restarted.flushFirstContacts();
		assert.equal(liveRequests.length, 0);
		assert.deepEqual(state.store.listRelationshipEventOutbox().map((record) => ({
			kind: record.kind,
			status: record.status,
		})), [{ kind: testExporter.kind, status: "pending" }]);
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
			state.gateway.acceptWebhook(attributedInbound()),
			/simulated first-contact crash/,
		);
		assert.equal(state.store.listRetryableEvents().length, 0);
		assert.equal(state.store.listRelationshipEventOutbox().length, 0);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM phone_conversations").get().count, 0);

		state.store.database.exec("DROP TRIGGER example_first_contact_crash");
		assert.equal(await state.gateway.acceptWebhook(attributedInbound()), "queued");
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
		await state.gateway.acceptWebhook(attributedInbound());
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
		await state.gateway.acceptWebhook(attributedInbound());
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

test("classifies retry rows when a restart lowers the delivery-attempt limit", async () => {
	const firstContact = exampleFirstContact();
	const state = subject(undefined, undefined, firstContact);
	try {
		await state.gateway.acceptWebhook(attributedInbound());
		const claimed = state.store.claimRelationshipEventOutbox({
			kind: firstContact.kind,
			maximumAttempts: 4,
			leaseSeconds: firstContact.leaseSeconds,
		});
		state.store.failRelationshipEventOutbox(claimed.idempotencyKey, "provider unavailable", {
			maximumAttempts: 4,
			retryDelaySeconds: 0,
		});
		assert.equal(state.store.listRelationshipEventOutbox()[0].status, "retry");

		assert.equal(state.store.claimRelationshipEventOutbox({
			kind: firstContact.kind,
			maximumAttempts: 1,
			leaseSeconds: firstContact.leaseSeconds,
		}), undefined);
		assert.equal(state.store.listRelationshipEventOutbox()[0].status, "terminal");
	} finally {
		state.close();
	}
});

test("contains background outbox failures without logging private exception content", async () => {
	const state = subject(undefined, undefined, exampleFirstContact());
	const previousConsoleError = console.error;
	const errors = [];
	console.error = (...parts) => errors.push(parts.join(" "));
	try {
		state.gateway.flushFirstContacts = async () => {
			throw new Error("private customer body from provider response");
		};
		state.gateway.requestFirstContactFlush();
		await new Promise((resolvePromise) => setImmediate(resolvePromise));
		assert.equal(
			errors.filter((message) => message === "troublemaker-hostd: relationship event outbox flush failed").length,
			1,
		);
		assert.equal(errors.join(" ").includes("private customer body"), false);
	} finally {
		console.error = previousConsoleError;
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

test("holds a new relationship turn only for the configured bounded burst window", async () => {
	const state = subject();
	try {
		state.config.scheduler = { relationshipBurstWindowMs: 1_500 };
		const observedAt = Date.now();
		assert.equal(await state.gateway.acceptWebhook(inbound(), { observedAt }), "queued");
		const [event] = state.store.listRetryableEvents();
		assert.equal(event.availableAt, new Date(observedAt + 1_500).toISOString());
		assert.equal(
			state.store.claimNextEvent({ relationshipBurstWindowMs: 1_500, maximumBatchSize: 10 }),
			null,
			"the Operator turn cannot start before the short window closes",
		);
		state.store.database.prepare("UPDATE events SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
			.run(event.id);
		assert.equal(
			state.store.claimNextEvent({ relationshipBurstWindowMs: 1_500, maximumBatchSize: 10 }).id,
			event.id,
			"the event is claimable immediately when the bound expires",
		);
	} finally {
		state.close();
	}
});
