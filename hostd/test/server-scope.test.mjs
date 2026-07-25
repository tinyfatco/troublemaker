import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextRouter } from "../src/router.mjs";
import { createHostServer } from "../src/server.mjs";
import { contextCapability, sealPrivateValue } from "../src/security.mjs";
import { HostStore } from "../src/store.mjs";

test("outbound Gmail is confined to the owning context", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-server-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const target = {
		id: "front-desk",
		driver: "oci",
		inboundToken: "test-inbound-secret",
		outboundToken: "test-outbound-secret",
	};
	const config = {
		server: {},
		routing: { actorTarget: "front-desk", knownPrincipals: [] },
		targetsById: new Map([["front-desk", target]]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 9));
	const owner = router.resolve({
		source: "gmail",
		threadId: "thread-owner",
		sender: "owner@example.com",
	});
	const stranger = router.resolve({
		source: "gmail",
		threadId: "thread-stranger",
		sender: "stranger@example.com",
	});
	const sends = [];
	const server = createHostServer({
		config,
		store,
		daemon: { polling: false },
		gmail: {
			sendThreadReply(threadId, subject, body) {
				sends.push({ threadId, subject, body });
				return { messageId: `sent-${sends.length}` };
			},
		},
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const ownerToken = contextCapability(target.outboundToken, "outbound", owner.contextId);

	try {
		const denied = await fetch(`${base}/v1/outbound/gmail`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ownerToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context_id: owner.contextId,
				provider_thread_id: stranger.providerThreadId,
				subject: "Re: Scope test",
				agent_body: "cross-context attempt",
				idempotency_key: "denied",
			}),
		});
		assert.equal(denied.status, 403);
		assert.equal(sends.length, 0);

		const sent = await fetch(`${base}/v1/outbound/gmail`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ownerToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context_id: owner.contextId,
				provider_thread_id: owner.providerThreadId,
				subject: "Re: Scope test",
				agent_body: "native Gmail reply",
				idempotency_key: "owner-reply",
			}),
		});
		assert.equal(sent.status, 200);
		assert.deepEqual(sends, [{
			threadId: "thread-owner",
			subject: "Re: Scope test",
			body: "native Gmail reply",
		}]);

		const duplicate = await fetch(`${base}/v1/outbound/gmail`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ownerToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context_id: owner.contextId,
				provider_thread_id: owner.providerThreadId,
				subject: "Re: Scope test",
				agent_body: "must not send twice",
				idempotency_key: "owner-reply",
			}),
		});
		assert.equal(duplicate.status, 200);
		assert.equal(sends.length, 1);

	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("outbound phone delivery accepts only the owning context and opaque direct target", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-phone-server-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const routingKey = Buffer.alloc(32, 6);
	const target = {
		id: "front-desk",
		driver: "oci",
		inboundToken: "test-inbound-secret",
		outboundToken: "test-outbound-secret",
	};
	const config = {
		server: {},
		routing: { actorTarget: "front-desk", knownPrincipals: [] },
		targetsById: new Map([["front-desk", target]]),
	};
	const router = new ContextRouter(config, store, routingKey);
	const ownerRoute = router.resolvePhone({
		providerThreadId: "owner-provider-thread",
		contactAddress: "+15555550123",
		label: "Phone •••• 0123",
	});
	const strangerRoute = router.resolvePhone({
		providerThreadId: "stranger-provider-thread",
		contactAddress: "+15555550124",
		label: "Phone •••• 0124",
	});
	const conversation = (threadTarget, contactAddress, route) => store.upsertPhoneConversation({
		threadTarget,
		provider: "sendly",
		providerThreadId: route.providerThreadId,
		principalHash: route.principalHash,
		targetId: route.targetId,
		contextId: route.contextId,
		contactCiphertext: sealPrivateValue(routingKey, "phone-contact", contactAddress),
		contactLastFour: contactAddress.slice(-4),
	});
	const owner = conversation("phone-0123456789abcdef0123", "+15555550123", ownerRoute);
	const stranger = conversation("phone-123456789abcdef01234", "+15555550124", strangerRoute);
	const sends = [];
	const server = createHostServer({
		config,
		store,
		daemon: {
			polling: false,
			controlNotifier: { wake() {} },
		},
		phoneGateway: {
			async sendDirect(selected, body) {
				sends.push({ threadTarget: selected.threadTarget, body });
				return { providerMessageId: `phone-sent-${sends.length}`, status: "queued" };
			},
		},
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const token = contextCapability(target.outboundToken, "outbound", owner.contextId);
	const post = (body) => fetch(`${base}/v1/outbound/phone`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});

	try {
		const denied = await post({
			context_id: owner.contextId,
			thread_target: stranger.threadTarget,
			agent_body: "Cross-context attempt.",
			idempotency_key: "phone-denied",
		});
		assert.equal(denied.status, 403);
		assert.equal(sends.length, 0);

		const sent = await post({
			context_id: owner.contextId,
			thread_target: owner.threadTarget,
			agent_body: "A direct agent-authored reply.",
			idempotency_key: "phone-owner-reply",
		});
		assert.equal(sent.status, 200);
		assert.deepEqual(sends, [{
			threadTarget: owner.threadTarget,
			body: "A direct agent-authored reply.",
		}]);

		const duplicate = await post({
			context_id: owner.contextId,
			thread_target: owner.threadTarget,
			agent_body: "A direct agent-authored reply.",
			idempotency_key: "phone-owner-reply",
		});
		assert.equal(duplicate.status, 200);
		assert.equal(sends.length, 1);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
