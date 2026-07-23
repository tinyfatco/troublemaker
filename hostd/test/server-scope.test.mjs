import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextRouter } from "../src/router.mjs";
import { createHostServer } from "../src/server.mjs";
import { contextCapability } from "../src/security.mjs";
import { HostStore } from "../src/store.mjs";

test("outbound Gmail and project binding are confined to the owning context", async () => {
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
		router,
		daemon: { polling: false },
		gmail: {
			sendThreadReply(threadId, body) {
				sends.push({ threadId, body });
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
				agent_body: "native Gmail reply",
				idempotency_key: "owner-reply",
			}),
		});
		assert.equal(sent.status, 200);
		assert.deepEqual(sends, [{ threadId: "thread-owner", body: "native Gmail reply" }]);

		const duplicate = await fetch(`${base}/v1/outbound/gmail`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ownerToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context_id: owner.contextId,
				provider_thread_id: owner.providerThreadId,
				agent_body: "must not send twice",
				idempotency_key: "owner-reply",
			}),
		});
		assert.equal(duplicate.status, 200);
		assert.equal(sends.length, 1);

		const bound = await fetch(`${base}/v1/context/bind-project`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ownerToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context_id: owner.contextId,
				provider_thread_id: owner.providerThreadId,
				project_slug: "site-redesign",
				project_name: "Site redesign",
			}),
		});
		assert.equal(bound.status, 200);
		const staged = store.getRoute("gmail", "thread-owner");
		assert.equal(staged.contextId, owner.contextId);
		assert.match(staged.nextContextId, /:site-redesign$/);

		const stillAllowed = await fetch(`${base}/v1/outbound/gmail`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ownerToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context_id: owner.contextId,
				provider_thread_id: owner.providerThreadId,
				agent_body: "reply after staging the project handoff",
				idempotency_key: "owner-reply-after-bind",
			}),
		});
		assert.equal(stillAllowed.status, 200);

		const activated = router.resolve({
			source: "gmail",
			threadId: "thread-owner",
			sender: "owner@example.com",
		});
		assert.match(activated.contextId, /:site-redesign$/);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
