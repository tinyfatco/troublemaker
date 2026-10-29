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
			localModels: [],
			advisorModel: "gpt-5.6-luna",
			defaultModel: "gpt-5.6-luna",
			allowedModels: ["gpt-5.6-luna", "gpt-5.6-sol"],
			maximumHistoryMessages: 24,
			maximumReplyCharacters: 1200,
			maximumOutputTokens: 512,
			pollIntervalSeconds: 1,
		},
	};
}

function localApiPhone() {
	const phone = apiPhone();
	phone.apiAgent.allowedModels.push("example-local");
	phone.apiAgent.localModels.push({
		id: "example-local",
		displayName: "Example Local",
		providerModel: "example/local-model",
		baseUrl: "http://127.0.0.1:19043/v1",
		apiKey: "synthetic-local-gateway-token-at-least-32-bytes",
		maximumOutputTokens: 150,
		repetitionPenalty: 1.1,
		requestTimeoutMs: 60_000,
		maximumRequestBytes: 64 * 1024,
	});
	return phone;
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
		assert.equal(providerCalls, 1);
	} finally {
		state.close();
	}
});

test("config and chat modes use approved models and send directly from Hostd", async () => {
	const modelCalls = [];
	const providerSends = [];
	let providerSequence = 0;
	const state = subject(
		async (url, options) => {
			assert.equal(url, "https://provider.example/api/v1/messages");
			providerSends.push(JSON.parse(options.body));
			providerSequence += 1;
			return Response.json({ id: `provider-direct-${providerSequence}`, status: "queued" });
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(target, contextId, model, maximumOutputTokens, body) {
				modelCalls.push({ target, contextId, model, maximumOutputTokens, body });
				if (modelCalls.length === 1) {
					return modelResponse(JSON.stringify({
						reply: "Sol is the deeper option. I selected it for chat.",
						selected_model: "gpt-5.6-sol",
					}), model);
				}
				return modelResponse("Chat mode is active. What would you like to discuss?", model);
			},
		},
	);
	try {
		const configure = inbound({ text: "/config" });
		assert.equal(await state.gateway.acceptWebhook(configure), "phone_api_queued");
		assert.equal(await state.gateway.acceptWebhook(configure), "duplicate");
		assert.equal(state.store.listRetryableEvents().length, 0);
		assert.deepEqual(state.counts(), { schedulerPumps: 0, notifierWakes: 0 });
		state.gateway.stopped = false;
		await state.gateway.flushApiAgent();

		const conversation = state.store.database.prepare(`
			SELECT thread_target AS threadTarget FROM phone_conversations LIMIT 1
		`).get();
		assert.ok(conversation);
		const configuredSession = state.store.getPhoneApiSession(conversation.threadTarget);
		assert.equal(configuredSession.threadTarget, conversation.threadTarget);
		assert.equal(configuredSession.mode, "config");
		assert.equal(configuredSession.selectedModel, "gpt-5.6-sol");
		assert.equal(configuredSession.generation, 3);
		assert.equal(modelCalls[0].model, "gpt-5.6-luna");
		assert.equal(modelCalls[0].maximumOutputTokens, 512);
		assert.deepEqual(modelCalls[0].body.tools, []);
		assert.equal(modelCalls[0].body.tool_choice, "none");
		assert.equal(providerSends[0].to, CONTACT_NUMBER);
		assert.equal(providerSends[0].from, BUSINESS_NUMBER);
		assert.equal(providerSends[0].text, "Sol is the deeper option. I selected it for chat.");

		const providerReplay = inbound({ text: "/chat" });
		providerReplay.id = "provider-event-replay-with-new-event-id";
		assert.equal(await state.gateway.acceptWebhook(providerReplay), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(state.store.getPhoneApiSession(conversation.threadTarget).mode, "config");
		assert.equal(modelCalls.length, 1);
		assert.equal(providerSends.length, 1);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM phone_api_turns").get().count, 1);

		const chat = inbound({ id: "provider-message-chat", text: "/chat" });
		chat.id = "provider-event-chat";
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(modelCalls[1].model, "gpt-5.6-sol");
		assert.equal(
			modelCalls[1].body.input.some((entry) => JSON.stringify(entry).includes("Sol is the deeper option")),
			true,
		);
		assert.deepEqual(
			modelCalls[1].body.input.map((entry) => [
				entry.role,
				entry.content.map((part) => part.type),
			]),
			[
				["developer", ["input_text"]],
				["user", ["input_text"]],
				["assistant", ["output_text"]],
				["user", ["input_text"]],
			],
		);
		assert.equal(providerSends[1].text, "Chat mode is active. What would you like to discuss?");
		assert.equal(await state.gateway.acceptWebhook({
			id: "provider-event-direct-delivered",
			type: "message.delivered",
			data: { object: {
				id: "provider-direct-2",
				from: BUSINESS_NUMBER,
				to: CONTACT_NUMBER,
				status: "delivered",
			} },
		}), "status");
		assert.equal(
			state.store.getPhoneApiTurn("phone-api:provider-message-chat").providerStatus,
			"delivered",
		);
		assert.equal(state.store.getPhoneApiSession(conversation.threadTarget).mode, "chat");
		assert.equal(state.store.getPhoneApiSession(conversation.threadTarget).selectedModel, "gpt-5.6-sol");
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM outbox").get().count, 0);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM phone_api_turns WHERE status = 'completed'").get().count, 2);
		assert.deepEqual(state.counts(), { schedulerPumps: 0, notifierWakes: 0 });
	} finally {
		state.close();
	}
});

test("config selects Example Local and chat uses only the bounded local gateway", async () => {
	const hostedCalls = [];
	const localCalls = [];
	const providerSends = [];
	const state = subject(
		async (_url, options) => {
			providerSends.push(JSON.parse(options.body));
			return Response.json({ id: `provider-local-${providerSends.length}`, status: "queued" });
		},
		localApiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _contextId, model, _maximumOutputTokens, body) {
				hostedCalls.push({ model, body });
				return modelResponse(JSON.stringify({
					reply: "Example Local is selected for chat.",
					selected_model: "example-local",
				}), model);
			},
		},
		{
			has(modelId) { return modelId === "example-local"; },
			async complete(modelId, messages) {
				localCalls.push({ modelId, messages });
				return "Example local model is on the line.";
			},
		},
	);
	try {
		assert.equal(await state.gateway.acceptWebhook(inbound({ text: "/config" })), "phone_api_queued");
		state.gateway.stopped = false;
		await state.gateway.flushApiAgent();
		const conversation = state.store.database.prepare(`
			SELECT thread_target AS threadTarget FROM phone_conversations LIMIT 1
		`).get();
		assert.equal(state.store.getPhoneApiSession(conversation.threadTarget).selectedModel, "example-local");
		assert.equal(hostedCalls.length, 1);
		assert.equal(
			hostedCalls[0].body.input.some((entry) => JSON.stringify(entry).includes("Example Local")),
			true,
		);
		assert.equal(providerSends[0].text, "Example Local is selected for chat.");

		const chat = inbound({ id: "provider-message-local-chat", text: "/chat" });
		chat.id = "provider-event-local-chat";
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(hostedCalls.length, 1);
		assert.equal(localCalls.length, 1);
		assert.equal(localCalls[0].modelId, "example-local");
		assert.equal(localCalls[0].messages[0].role, "system");
		assert.match(localCalls[0].messages[0].content, /Example Local/);
		assert.equal(providerSends[1].text, "Example local model is on the line.");
		assert.equal(
			state.store.getPhoneApiTurn("phone-api:provider-message-local-chat").model,
			"example-local",
		);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
		assert.equal(state.store.database.prepare("SELECT COUNT(*) AS count FROM outbox").get().count, 0);
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
			if (providerSends.length === 2) {
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
					selected_model: "example-local",
				}), model);
			},
		},
		{
			has(modelId) { return modelId === "example-local"; },
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
		const chat = inbound({ id: "provider-message-compliance", text: "/chat" });
		chat.id = "provider-event-compliance";
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(providerSends.length, 3);
		assert.equal(localCalls.length, 2);
		assert.doesNotMatch(localCalls[0].messages[0].content, /carrier-safe|provider rejected the prior draft/i);
		assert.match(localCalls[1].messages[0].content, /provider rejected the prior draft/i);
		assert.equal(localCalls[1].messages.at(-1).role, "user");
		assert.match(localCalls[1].messages.at(-1).content, /Rewrite your answer.*carrier-safe SMS/i);
		assert.equal(providerSends[1].text, "A synthetic first draft rejected by the provider.");
		assert.equal(providerSends[2].text, "A playful carrier-safe replacement.");
		const turn = state.store.getPhoneApiTurn("phone-api:provider-message-compliance");
		assert.equal(turn.status, "completed");
		assert.equal(turn.replyBody, "A playful carrier-safe replacement.");
		assert.equal(turn.providerReplyMessageId, "provider-compliance-3");
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
			if (providerCalls === 1) {
				return Response.json({ id: "provider-config", status: "queued" });
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
					selected_model: "example-local",
				}), model);
			},
		},
		{
			has(modelId) { return modelId === "example-local"; },
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
		const chat = inbound({ id: "provider-message-compliance-twice", text: "/chat" });
		chat.id = "provider-event-compliance-twice";
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		await state.gateway.flushApiAgent();
		assert.equal(providerCalls, 3);
		assert.equal(localCalls, 2);
		const turn = state.store.getPhoneApiTurn("phone-api:provider-message-compliance-twice");
		assert.equal(turn.status, "failed");
		assert.match(turn.lastError, /compliance_blocked\/SHAFT_CONTENT_DETECTED\/alcohol/);
		await state.gateway.flushApiAgent();
		assert.equal(providerCalls, 3);
	} finally {
		state.close();
	}
});

test("an ambiguous direct provider result is never retried", async () => {
	let providerCalls = 0;
	const state = subject(
		async () => {
			providerCalls += 1;
			throw new TypeError("synthetic connection loss");
		},
		apiPhone(),
		undefined,
		{
			async completeDirectPhone(_target, _contextId, model) {
				return modelResponse("This reply has one uncertain provider attempt.", model);
			},
		},
	);
	try {
		const chat = inbound({ text: "/chat" });
		assert.equal(await state.gateway.acceptWebhook(chat), "phone_api_queued");
		state.gateway.stopped = false;
		await state.gateway.flushApiAgent();
		const turn = state.store.getPhoneApiTurn("phone-api:provider-message-inbound");
		assert.equal(turn.status, "uncertain");
		assert.equal(providerCalls, 1);
		await state.gateway.flushApiAgent();
		assert.equal(providerCalls, 1);
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
