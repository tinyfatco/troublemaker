import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZulipResidentBridge } from "../src/zulip-resident-bridge.mjs";

const CHANNEL_ID = 4;
const BOT_USER_ID = 9;
const OTHER_BOT_USER_ID = 10;
const NATIVE_EMAIL = "agent@example.com";
const NATIVE_KEY = "native-test-key";
const PROXY_TOKEN = "proxy-test-token";
const INBOUND_TOKEN = "inbound-test-token";
const RECEIPT_TOKEN = "receipt-test-token";
const expectedBasic = `Basic ${Buffer.from(`${NATIVE_EMAIL}:${NATIVE_KEY}`).toString("base64")}`;
const messages = new Map();
const events = [];
const outbound = [];
const subscriptions = [{ stream_id: CHANNEL_ID, name: "Crew", topics_policy: "empty_topic_only" }];
let registerCount = 0;
let expireNextPoll = false;
let nextMessageId = 100;

messages.set(50, {
	id: 50,
	type: "stream",
	stream_id: CHANNEL_ID,
	display_recipient: "Crew",
	subject: "",
	sender_id: 8,
	sender_email: "alex@example.com",
	sender_full_name: "Alex",
	timestamp: Math.floor(Date.now() / 1000),
	content: "<p>Old message.</p>",
	raw_content: "Old message.",
	is_mentioned: false,
});

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function sendJson(response, status, value) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

const nativeServer = createServer(async (request, response) => {
	assert.equal(request.headers.authorization, expectedBasic);
	const url = new URL(request.url || "/", "http://127.0.0.1");
	if (request.method === "GET" && url.pathname === "/api/v1/users/me") {
		sendJson(response, 200, {
			result: "success",
			msg: "",
			user_id: BOT_USER_ID,
			email: NATIVE_EMAIL,
			full_name: "Agent",
			is_bot: true,
		});
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/v1/users") {
		sendJson(response, 200, {
			result: "success",
			msg: "",
			members: [
				{ user_id: 8, email: "alex@example.com", full_name: "Alex", is_bot: false },
				{ user_id: BOT_USER_ID, email: NATIVE_EMAIL, full_name: "Agent", is_bot: true },
				{ user_id: OTHER_BOT_USER_ID, email: "other-agent@example.com", full_name: "Other Agent", is_bot: true },
			],
		});
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/v1/users/me/subscriptions") {
		sendJson(response, 200, { result: "success", msg: "", subscriptions });
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/v1/streams") {
		sendJson(response, 200, {
			result: "success",
			msg: "",
			streams: [
				{ stream_id: CHANNEL_ID, name: "Crew", topics_policy: "empty_topic_only" },
				{ stream_id: 5, name: "Other", topics_policy: "empty_topic_only" },
			],
		});
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/v1/register") {
		registerCount += 1;
		const latestEventId = events.reduce((maximum, event) => Math.max(maximum, event.id), 0);
		sendJson(response, 200, { result: "success", msg: "", queue_id: `queue-${registerCount}`, last_event_id: latestEventId });
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/v1/events") {
		if (expireNextPoll) {
			expireNextPoll = false;
			response.writeHead(400, { "content-type": "text/html" });
			response.end("<html><body>expired event queue</body></html>");
			return;
		}
		const lastEventId = Number(url.searchParams.get("last_event_id") || -1);
		sendJson(response, 200, {
			result: "success",
			msg: "",
			events: events.filter((event) => event.id > lastEventId),
		});
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/v1/messages") {
		const ordered = Array.from(messages.values()).sort((left, right) => left.id - right.id);
		const anchor = url.searchParams.get("anchor");
		const selected = anchor === "newest"
			? ordered.slice(-Number(url.searchParams.get("num_before") || 1))
			: ordered.filter((message) => message.id > Number(anchor || 0)).slice(0, Number(url.searchParams.get("num_after") || 100));
		sendJson(response, 200, { result: "success", msg: "", messages: selected });
		return;
	}
	const detailMatch = url.pathname.match(/^\/api\/v1\/messages\/([1-9]\d*)$/);
	if (request.method === "GET" && detailMatch) {
		const message = messages.get(Number(detailMatch[1]));
		if (!message) return sendJson(response, 404, { result: "error", msg: "not found" });
		sendJson(response, 200, { result: "success", msg: "", message });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/v1/messages") {
		const body = new URLSearchParams((await readBody(request)).toString("utf8"));
		outbound.push(Object.fromEntries(body));
		const id = nextMessageId++;
		const common = {
			id,
			sender_id: BOT_USER_ID,
			sender_email: NATIVE_EMAIL,
			sender_full_name: "Agent",
			timestamp: Math.floor(Date.now() / 1000),
			content: body.get("content"),
			raw_content: body.get("content"),
			is_mentioned: false,
		};
		if (body.get("type") === "direct") {
			const recipientIds = JSON.parse(body.get("to"));
			messages.set(id, {
				...common,
				type: "private",
				recipient_id: 12,
				display_recipient: [
					...recipientIds.map((userId) => ({ id: userId, email: "alex@example.com", full_name: "Alex" })),
					{ id: BOT_USER_ID, email: NATIVE_EMAIL, full_name: "Agent" },
				],
			});
		} else {
			messages.set(id, {
				...common,
				type: "stream",
				stream_id: Number(body.get("to")),
				display_recipient: "Crew",
				subject: body.get("topic") || "",
			});
		}
		sendJson(response, 200, { result: "success", msg: "", id });
		return;
	}
	if (detailMatch && request.method === "PATCH") {
		sendJson(response, 200, { result: "success", msg: "" });
		return;
	}
	if (detailMatch && request.method === "DELETE") {
		sendJson(response, 200, { result: "success", msg: "" });
		return;
	}
	sendJson(response, 404, { result: "error", msg: `unhandled ${request.method} ${url.pathname}` });
});
await new Promise((resolve) => nativeServer.listen(0, "127.0.0.1", resolve));
const nativeAddress = nativeServer.address();

const inboundDeliveries = [];
const inboundServer = createServer(async (request, response) => {
	assert.equal(request.headers.authorization, `Bearer ${INBOUND_TOKEN}`);
	const payload = JSON.parse((await readBody(request)).toString("utf8"));
	inboundDeliveries.push(payload);
	sendJson(response, 202, { ok: true, accepted: true });
	for (const status of ["running", "completed"]) {
		const receiptResponse = await fetch(payload.hostReceipt.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${payload.hostReceipt.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ status, lease_token: payload.hostReceipt.leaseToken }),
		});
		assert.equal(receiptResponse.status, 200);
	}
});
await new Promise((resolve) => inboundServer.listen(0, "127.0.0.1", resolve));
const inboundAddress = inboundServer.address();

async function waitFor(predicate, label) {
	for (let index = 0; index < 300; index++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

const workingDir = mkdtempSync(join(tmpdir(), "zulip-resident-bridge-test-"));
const statePath = join(workingDir, "state.json");
const bridge = new ZulipResidentBridge({
	zulipUrl: `http://127.0.0.1:${nativeAddress.port}`,
	zulipEmail: NATIVE_EMAIL,
	zulipApiKey: NATIVE_KEY,
	allowedDmUserIds: [8],
	proxyToken: PROXY_TOKEN,
	inboundUrl: `http://127.0.0.1:${inboundAddress.port}/zulip/inbound`,
	inboundToken: INBOUND_TOKEN,
	receiptToken: RECEIPT_TOKEN,
	statePath,
	listenHost: "127.0.0.1",
	listenPort: 0,
});

try {
	await bridge.start();
	assert.equal(inboundDeliveries.length, 0, "first start does not replay historical channel messages");
	assert.equal(JSON.parse(readFileSync(statePath, "utf8")).lastMessageId, 50);

	const ambientMessage = {
		id: 51,
		type: "stream",
		stream_id: CHANNEL_ID,
		display_recipient: "Crew",
		subject: "",
		sender_id: 8,
		sender_email: "alex@example.com",
		sender_full_name: "Alex",
		timestamp: Math.floor(Date.now() / 1000),
		content: "<p>Ambient update.</p>",
		raw_content: "Ambient update.",
		is_mentioned: false,
	};
	messages.set(ambientMessage.id, ambientMessage);
	events.push({ id: 1, type: "message", message: ambientMessage });
	await waitFor(() => inboundDeliveries.length === 1, "ambient delivery");
	assert.equal(inboundDeliveries[0].deliveryId, "zulip:51");
	assert.equal(inboundDeliveries[0].message.is_mentioned, false);
	assert.equal(inboundDeliveries[0].message.raw_content, "Ambient update.");
	assert.equal(inboundDeliveries[0].message.sender_is_bot, false);

	const otherBotMessage = {
		...ambientMessage,
		id: 52,
		sender_id: OTHER_BOT_USER_ID,
		sender_email: "other-agent@example.com",
		sender_full_name: "Other Agent",
		content: "<p>Other agent update.</p>",
		raw_content: "Other agent update.",
	};
	messages.set(otherBotMessage.id, otherBotMessage);
	events.push({ id: 2, type: "message", message: otherBotMessage });
	await waitFor(() => inboundDeliveries.length === 2, "other bot delivery");
	assert.equal(inboundDeliveries[1].deliveryId, "zulip:52");
	assert.equal(inboundDeliveries[1].message.sender_is_bot, true);

	const directMessage = {
		id: 53,
		type: "private",
		recipient_id: 12,
		display_recipient: [
			{ id: 8, email: "alex@example.com", full_name: "Alex" },
			{ id: BOT_USER_ID, email: NATIVE_EMAIL, full_name: "Agent" },
		],
		sender_id: 8,
		sender_email: "alex@example.com",
		sender_full_name: "Alex",
		timestamp: Math.floor(Date.now() / 1000),
		content: "<p>Direct hello.</p>",
	};
	messages.set(directMessage.id, directMessage);
	events.push({ id: 3, type: "message", message: directMessage });
	await waitFor(() => inboundDeliveries.length === 3, "direct-message delivery");
	assert.equal(inboundDeliveries[2].deliveryId, "zulip:53");
	assert.equal(inboundDeliveries[2].message.type, "private");
	assert.equal(inboundDeliveries[2].message.sender_is_bot, false);
	assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).knownDirectConversations, ["dm:8"]);

	const groupDirectMessage = {
		...directMessage,
		id: 54,
		recipient_id: 13,
		display_recipient: [
			{ id: 8, email: "alex@example.com", full_name: "Alex" },
			{ id: 12, email: "teammate@example.com", full_name: "Teammate" },
			{ id: BOT_USER_ID, email: NATIVE_EMAIL, full_name: "Agent" },
		],
		content: "<p>Group direct hello.</p>",
	};
	messages.set(groupDirectMessage.id, groupDirectMessage);
	events.push({ id: 4, type: "message", message: groupDirectMessage });
	await waitFor(() => inboundDeliveries.length === 4, "group direct-message delivery");
	assert.equal(inboundDeliveries[3].message.type, "private");
	assert.deepEqual(
		JSON.parse(readFileSync(statePath, "utf8")).knownDirectConversations,
		["dm:8", "dm:8,12"],
	);

	subscriptions.push({ stream_id: 5, name: "Projects", topics_policy: "disable_empty_topic" });
	const newlySubscribedMessage = {
		...ambientMessage,
		id: 55,
		stream_id: 5,
		display_recipient: "Projects",
		subject: "Roadmap",
		content: "<p>New channel update.</p>",
		raw_content: "New channel update.",
	};
	messages.set(newlySubscribedMessage.id, newlySubscribedMessage);
	events.push({ id: 5, type: "message", message: newlySubscribedMessage });
	await waitFor(() => inboundDeliveries.length === 5, "newly subscribed channel delivery");
	assert.equal(inboundDeliveries[4].message.stream_id, 5);
	assert.equal(inboundDeliveries[4].message.subject, "Roadmap");

	const proxyAuthorization = { authorization: `Bearer ${PROXY_TOKEN}` };
	const meResponse = await fetch(`${bridge.proxyUrl()}/api/v1/users/me`, { headers: proxyAuthorization });
	assert.equal(meResponse.status, 200);
	assert.equal((await meResponse.json()).user_id, BOT_USER_ID);
	const streamsResponse = await fetch(`${bridge.proxyUrl()}/api/v1/streams`, { headers: proxyAuthorization });
	const filteredStreams = (await streamsResponse.json()).streams;
	assert.deepEqual(filteredStreams.map((stream) => stream.stream_id), [CHANNEL_ID, 5]);
	const usersResponse = await fetch(`${bridge.proxyUrl()}/api/v1/users`, { headers: proxyAuthorization });
	assert.equal(usersResponse.status, 404, "the resident proxy never exposes the native user directory");
	const denied = await fetch(`${bridge.proxyUrl()}/api/v1/messages`, {
		method: "POST",
		headers: proxyAuthorization,
		body: new URLSearchParams({ type: "channel", to: "6", topic: "", content: "escape" }),
	});
	assert.equal(denied.status, 403);
	const sent = await fetch(`${bridge.proxyUrl()}/api/v1/messages`, {
		method: "POST",
		headers: proxyAuthorization,
		body: new URLSearchParams({ type: "channel", to: String(CHANNEL_ID), topic: "", content: "Agent reply" }),
	});
	assert.equal(sent.status, 200);
	assert.equal(outbound.at(-1).content, "Agent reply");
	const directSent = await fetch(`${bridge.proxyUrl()}/api/v1/messages`, {
		method: "POST",
		headers: proxyAuthorization,
		body: new URLSearchParams({ type: "direct", to: JSON.stringify([8]), content: "Direct reply" }),
	});
	assert.equal(directSent.status, 200);
	assert.equal(outbound.at(-1).type, "direct");
	assert.equal(outbound.at(-1).to, "[8]");
	const groupDirectSent = await fetch(`${bridge.proxyUrl()}/api/v1/messages`, {
		method: "POST",
		headers: proxyAuthorization,
		body: new URLSearchParams({ type: "direct", to: JSON.stringify([12, 8]), content: "Group reply" }),
	});
	assert.equal(groupDirectSent.status, 200);
	assert.equal(outbound.at(-1).type, "direct");
	assert.equal(outbound.at(-1).to, "[8,12]");

	expireNextPoll = true;
	await waitFor(() => registerCount >= 2, "expired queue recovery");
	const mentionMessage = {
		...ambientMessage,
		id: 201,
		content: "<p>@Agent please reply.</p>",
		raw_content: "@**Agent** please reply.",
		flags: ["mentioned"],
	};
	messages.set(mentionMessage.id, mentionMessage);
	const { flags: _detailOnlyFlags, ...mentionEventMessage } = mentionMessage;
	events.push({ id: 6, type: "message", message: mentionEventMessage });
	await waitFor(() => inboundDeliveries.some((delivery) => delivery.deliveryId === "zulip:201"), "mention delivery after recovery");
	const mentionDelivery = inboundDeliveries.find((delivery) => delivery.deliveryId === "zulip:201");
	assert.deepEqual(mentionDelivery.message.flags, ["mentioned"]);
	assert.equal(mentionDelivery.message.sender_is_bot, false);
	await waitFor(
		() => JSON.parse(readFileSync(statePath, "utf8")).lastMessageId === 201,
		"durable recovered cursor",
	);
	assert.equal(JSON.parse(readFileSync(statePath, "utf8")).lastMessageId, 201);
} finally {
	await bridge.stop();
	await new Promise((resolve) => inboundServer.close(() => resolve()));
	await new Promise((resolve) => nativeServer.close(() => resolve()));
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("zulip resident bridge ok");
