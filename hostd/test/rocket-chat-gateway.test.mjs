import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RocketChatGateway } from "../src/rocket-chat-gateway.mjs";
import { RocketChatProvisioner } from "../src/rocket-chat.mjs";
import { HostStore } from "../src/store.mjs";

const ADMIN_TOKEN = "admin-test-token";
const ADMIN_USER_ID = "adminUser123";
const CONTEXT_TOKEN = "context-proxy-token";
const ROOM_ID = "roomCustomer123";
const HUMAN_ID = "humanOperator123";
const ROOT_ID = "messageRoot123";
const AGENT_MESSAGE_ID = "messageAgent123";
const AGENT_ID = "agentOperator123";
const AGENT_TOKEN = "agent-test-token";
const AGENT_USERNAME = "operator-customer";
const FILE_ID = "fileInbound123";
const FILE_NAME = "brief.txt";
const FILE_CONTENT = "customer attachment";

async function requestBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function waitFor(predicate) {
	for (let index = 0; index < 100; index++) {
		if (predicate()) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	throw new Error("timed out waiting for Rocket.Chat gateway event");
}

test("Rocket.Chat gateway journals room ingress and scopes idempotent agent posts", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-rocketchat-gateway-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const contextId = "front-desk:0123456789abcdef01234567:website";
	store.createContext({
		id: contextId,
		targetId: "front-desk",
		driver: "oci",
		runtimeName: "troublemaker-front-desk-test",
		port: 32000,
	});
	store.upsertRocketChatBinding({
		contextId,
		contactId: "contactCustomer123",
		roomId: ROOM_ID,
		roomName: "customer-opaque",
		botUserId: AGENT_ID,
		botUsername: AGENT_USERNAME,
		channelDisplayName: "customer@example.com",
	});
	const credentialsDirectory = join(directory, "rocket-chat-secrets");
	mkdirSync(credentialsDirectory, { recursive: true, mode: 0o700 });
	const suffix = createHash("sha256").update(contextId).digest("hex").slice(0, 20);
	writeFileSync(
		join(credentialsDirectory, `${suffix}.json`),
		`${JSON.stringify({
			userId: AGENT_ID,
			authToken: AGENT_TOKEN,
			username: AGENT_USERNAME,
		})}\n`,
		{ mode: 0o600 },
	);

	const messages = [];
	let postCreates = 0;
	const upstream = createServer(async (request, response) => {
		const url = new URL(request.url || "/", "http://127.0.0.1");
		const send = (status, value) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		const isAdmin = (
			request.headers["x-auth-token"] === ADMIN_TOKEN
			&& request.headers["x-user-id"] === ADMIN_USER_ID
		);
		const isAgent = (
			request.headers["x-auth-token"] === AGENT_TOKEN
			&& request.headers["x-user-id"] === AGENT_ID
		);
		if (!isAdmin && !isAgent) {
			send(401, { success: false, error: "unauthorized" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/v1/me") {
			assert(isAgent);
			send(200, {
				success: true,
				_id: AGENT_ID,
				username: AGENT_USERNAME,
				name: "Operator",
				roles: ["user", "bot"],
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/v1/groups.info") {
			send(200, {
				success: true,
				group: { _id: ROOM_ID, name: "customer-opaque", t: "p" },
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/v1/groups.history") {
			send(200, { success: true, messages });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/v1/chat.getMessage") {
			const requestedMessageId = url.searchParams.get("msgId");
			send(200, {
				success: true,
				message: {
					_id: requestedMessageId,
					rid: ROOM_ID,
					msg: "root",
					...(requestedMessageId === ROOT_ID
						? { file: { _id: FILE_ID, name: FILE_NAME, type: "text/plain" } }
						: {}),
				},
			});
			return;
		}
		if (
			request.method === "GET"
			&& url.pathname === `/file-upload/${FILE_ID}/${FILE_NAME}`
		) {
			assert(isAgent, "attachment downloads must use Operator's Rocket.Chat credentials");
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(FILE_CONTENT);
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/v1/chat.getThreadMessages") {
			send(200, {
				success: true,
				messages: [
					{ _id: ROOT_ID, rid: ROOM_ID, msg: "root", u: { _id: HUMAN_ID, username: "operator" } },
				],
				count: 1,
				offset: 0,
				total: 1,
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/v1/chat.postMessage") {
			assert(isAgent, "agent posts must use Operator's Rocket.Chat credentials");
			const input = await requestBody(request);
			const message = {
				_id: AGENT_MESSAGE_ID,
				rid: ROOM_ID,
				msg: input.text,
				...(input.tmid ? { tmid: input.tmid } : {}),
				customFields: input.customFields,
				u: { _id: AGENT_ID, username: AGENT_USERNAME, name: "Operator" },
			};
			messages.push(message);
			postCreates++;
			send(200, { success: true, message });
			return;
		}
		send(404, { success: false, error: `unhandled ${request.method} ${url.pathname}` });
	});
	const webSocketServer = new WebSocketServer({ noServer: true });
	upstream.on("upgrade", (request, socket, head) => {
		webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
			webSocketServer.emit("connection", websocket, request);
		});
	});
	webSocketServer.on("connection", (websocket) => {
		websocket.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.msg === "connect") {
				websocket.send(JSON.stringify({ msg: "connected", session: "session-one" }));
			}
			if (message.msg === "method" && message.method === "login") {
				assert.equal(message.params[0].resume, ADMIN_TOKEN);
				websocket.send(JSON.stringify({ msg: "result", id: message.id, result: { id: ADMIN_USER_ID } }));
			}
			if (message.msg === "sub" && message.name === "stream-room-messages") {
				assert.deepEqual(message.params, ["__my_messages__", false]);
				websocket.send(JSON.stringify({ msg: "ready", subs: [message.id] }));
			}
		});
	});
	await new Promise((resolvePromise) => upstream.listen(0, "127.0.0.1", resolvePromise));
	const upstreamAddress = upstream.address();
	assert(upstreamAddress && typeof upstreamAddress === "object");
	const config = {
		rocketChat: {
			url: `http://127.0.0.1:${upstreamAddress.port}`,
			adminUserId: ADMIN_USER_ID,
			adminToken: ADMIN_TOKEN,
			credentialsDirectory,
			memberUsernames: [],
			agentUsernamePrefix: "operator",
			agentDisplayName: "Operator",
			notifierUsername: "tinyfat",
			notifierDisplayName: "TINYFAT",
		},
	};
	const provisioner = new RocketChatProvisioner(config.rocketChat, store);
	let pumps = 0;
	const gateway = new RocketChatGateway({
		config,
		store,
		provisioner,
		scheduler: { pump() { pumps++; } },
	});
	const proxy = createServer((request, response) => {
		const url = new URL(request.url || "/", "http://127.0.0.1");
		void gateway.proxy(request, response, contextId, `${url.pathname}${url.search}`, CONTEXT_TOKEN);
	});
	await new Promise((resolvePromise) => proxy.listen(0, "127.0.0.1", resolvePromise));
	const proxyAddress = proxy.address();
	assert(proxyAddress && typeof proxyAddress === "object");

	try {
		await gateway.start();
		const inbound = {
			_id: ROOT_ID,
			rid: ROOM_ID,
			msg: "Please ship the private review.",
			u: { _id: HUMAN_ID, username: "operator", name: "Operator" },
			ts: new Date().toISOString(),
		};
		for (const client of webSocketServer.clients) {
			client.send(JSON.stringify({
				msg: "changed",
				collection: "stream-room-messages",
				fields: { eventName: ROOM_ID, args: [inbound] },
			}));
		}
		await waitFor(() => Boolean(store.getEventByProviderMessage("rocket-chat", ROOT_ID)));
		const event = store.getEventByProviderMessage("rocket-chat", ROOT_ID);
		assert.equal(event.contextId, contextId);
		assert.equal(event.awarenessSequence, 1);
		assert.equal(pumps, 1);

		const projected = {
			...inbound,
			_id: "messageProjection123",
			customFields: {
				tinyfat: {
					eventId: "email:event-one",
					customerChannelId: contextId,
				},
			},
		};
		for (const client of webSocketServer.clients) {
			client.send(JSON.stringify({
				msg: "changed",
				collection: "stream-room-messages",
				fields: { eventName: ROOM_ID, args: [projected] },
			}));
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
		assert.equal(store.getEventByProviderMessage("rocket-chat", projected._id), undefined);

		const endpoint = `http://127.0.0.1:${proxyAddress.port}/chat.postMessage`;
		const body = {
			roomId: ROOM_ID,
			text: "The private review is ready.",
			tmid: ROOT_ID,
			tinyfatEventId: "rocket-chat:event-agent-one",
		};
		const first = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${CONTEXT_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		assert.equal(first.status, 200);
		assert.equal((await first.json()).message._id, AGENT_MESSAGE_ID);
		const duplicate = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${CONTEXT_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		assert.equal(duplicate.status, 200);
		assert.equal((await duplicate.json()).duplicate, true);
			assert.equal(postCreates, 1);
			assert.equal(messages[0].u._id, AGENT_ID);
		assert.deepEqual(messages[0].customFields.tinyfat, {
			schema: 1,
			kind: "collaboration.message.recorded",
			eventId: "rocket-chat:event-agent-one",
			customerChannelId: contextId,
			sequence: 2,
			source: "rocket-chat",
			actorKind: "agent",
			actorId: "front-desk",
			visibility: "channel",
		});

		const denied = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${CONTEXT_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ ...body, roomId: "roomOutsideScope123", tinyfatEventId: "rocket-chat:denied-one" }),
		});
		assert.equal(denied.status, 403);

		const attachment = await fetch(
			`http://127.0.0.1:${proxyAddress.port}/files/${ROOT_ID}/${FILE_ID}/${FILE_NAME}`,
			{ headers: { authorization: `Bearer ${CONTEXT_TOKEN}` } },
		);
		assert.equal(attachment.status, 200);
		assert.equal(await attachment.text(), FILE_CONTENT);
		const deniedAttachment = await fetch(
			`http://127.0.0.1:${proxyAddress.port}/files/${ROOT_ID}/fileOutside123/${FILE_NAME}`,
			{ headers: { authorization: `Bearer ${CONTEXT_TOKEN}` } },
		);
		assert.equal(deniedAttachment.status, 403);
	} finally {
		await gateway.stop();
		await new Promise((resolvePromise) => proxy.close(resolvePromise));
		await new Promise((resolvePromise) => upstream.close(resolvePromise));
		webSocketServer.close();
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
