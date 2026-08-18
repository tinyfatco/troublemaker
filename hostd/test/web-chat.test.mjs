import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextRouter } from "../src/router.mjs";
import { HostStore } from "../src/store.mjs";
import {
	decryptWebChatRelayPayload,
	encryptWebChatRelayPayload,
	WebChatGateway,
} from "../src/web-chat.mjs";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const messageId = "123e4567-e89b-42d3-a456-426614174001";
const claimId = "123e4567-e89b-42d3-a456-426614174002";
const createdAt = "2026-08-18T12:00:00.000Z";
const encryptionKey = Buffer.alloc(32, 23).toString("base64");

test("website chat relay binds one isolated context, deduplicates ingress, and returns Operator replies", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-web-chat-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const target = { id: "front-desk", driver: "oci" };
	const config = {
		webChat: {
			relay: {
				url: "https://relay.example/api/internal/landing-chat",
				token: "test-relay-token-at-least-thirty-two-characters",
				encryptionKey,
				pollIntervalSeconds: 1,
			},
		},
		routing: { actorTarget: "front-desk", knownPrincipals: [] },
		targetsById: new Map([["front-desk", target]]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 7));
	const encrypted = encryptWebChatRelayPayload({
		sessionId,
		messageId,
		body: "Can Troublemaker help with my website?",
		createdAt,
	}, encryptionKey, messageId);
	const acknowledgements = [];
	const publications = [];
	let controlWakes = 0;
	let schedulerPumps = 0;
	const fetchImpl = async (url, init) => {
		assert.equal(init.headers.authorization, `Bearer ${config.webChat.relay.token}`);
		if (url.endsWith("/pull")) {
			return Response.json({
				claimId,
				events: [{
					id: messageId,
					receivedAt: "2026-08-18T12:00:00+00:00",
					...encrypted,
				}],
			});
		}
		if (url.endsWith("/ack")) {
			acknowledgements.push(JSON.parse(init.body));
			return Response.json({ ok: true });
		}
		if (url.endsWith("/publish")) {
			const input = JSON.parse(init.body);
			publications.push({
				...input,
				plaintext: decryptWebChatRelayPayload({
					id: input.id,
					receivedAt: createdAt,
					iv: input.iv,
					ciphertext: input.ciphertext,
				}, encryptionKey),
			});
			return Response.json({ ok: true });
		}
		return new Response("not found", { status: 404 });
	};
	const gateway = new WebChatGateway({
		config,
		store,
		router,
		controlNotifier: { wake() { controlWakes++; } },
		scheduler: { pump() { schedulerPumps++; } },
		fetchImpl,
	});

	try {
		await gateway.pollInbound();
		await gateway.pollInbound();
		const event = store.getEventByProviderMessage("web_chat", messageId);
		assert(event);
		assert.match(event.contextId, /^front-desk:[a-f0-9]{24}:website-chat$/);
		assert.equal(JSON.parse(event.payloadJson).message.body, "Can Troublemaker help with my website?");
		assert.equal(store.status().webChatConversations, 1);
		assert.equal(acknowledgements.length, 2, "duplicates are acknowledged without creating a second event");
		assert.deepEqual(acknowledgements[0], { claimId, ids: [messageId] });
		assert.equal(controlWakes, 1);
		assert.equal(schedulerPumps, 1);

		assert(gateway.queueOperatorMessage(event.contextId, "901", "Yes. What would you like to change?"));
		await gateway.flushOutbound();
		assert.equal(publications.length, 1);
		assert.equal(publications[0].id, "zulip:901");
		assert.equal(publications[0].sessionId, sessionId);
		assert.deepEqual(publications[0].plaintext, {
			sessionId,
			messageId: "zulip:901",
			body: "Yes. What would you like to change?",
			createdAt: publications[0].plaintext.createdAt,
		});
		assert(Number.isFinite(Date.parse(publications[0].plaintext.createdAt)));
		assert.equal(store.getWebChatOutbox("zulip:901").status, "completed");
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
