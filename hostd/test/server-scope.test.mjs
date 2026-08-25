import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextRouter } from "../src/router.mjs";
import { HostMcp } from "../src/mcp.mjs";
import { PhoneDeliveryUncertainError } from "../src/phone.mjs";
import { createHostServer } from "../src/server.mjs";
import { contextCapability, sealPrivateValue } from "../src/security.mjs";
import { HostStore } from "../src/store.mjs";

test("operator status is private even if a caller constructs an incomplete config", async () => {
	const token = "example-operator-token-at-least-32-bytes";
	const store = {
		getMeta() { return "false"; },
		status() { return { contexts: 0 }; },
		listContexts() { return []; },
	};
	const server = createHostServer({
		config: {
			server: { operatorToken: token },
			scheduler: { maxConcurrent: 1 },
			targetsById: new Map(),
		},
		store,
		daemon: { polling: false },
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	try {
		assert.equal((await fetch(`${base}/health`)).status, 200);
		assert.equal((await fetch(`${base}/v1/status`)).status, 401);
		assert.equal((await fetch(`${base}/v1/status`, {
			headers: { authorization: "Bearer wrong" },
		})).status, 401);
		assert.equal((await fetch(`${base}/v1/status`, {
			headers: { authorization: token },
		})).status, 401);
		assert.equal((await fetch(`${base}/v1/status`, {
			headers: { authorization: `Bearer ${token}` },
		})).status, 200);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => (
			error ? reject(error) : resolvePromise()
		)));
	}

	const missingTokenServer = createHostServer({
		config: {
			server: {},
			scheduler: { maxConcurrent: 1 },
			targetsById: new Map(),
		},
		store,
		daemon: { polling: false },
	});
	await new Promise((resolvePromise) => missingTokenServer.listen(0, "127.0.0.1", resolvePromise));
	const missingAddress = missingTokenServer.address();
	assert(missingAddress && typeof missingAddress === "object");
	try {
		assert.equal((await fetch(`http://127.0.0.1:${missingAddress.port}/v1/status`)).status, 401);
	} finally {
		await new Promise((resolvePromise, reject) => missingTokenServer.close((error) => (
			error ? reject(error) : resolvePromise()
		)));
	}
});

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
		gmail: { account: "agent@example.com" },
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

test("phone-only hosts expose no Gmail delivery surface", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-no-gmail-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const server = createHostServer({
		config: {
			server: {},
			gmail: undefined,
			scheduler: { maxConcurrent: 1 },
			targetsById: new Map(),
		},
		store,
		daemon: { polling: false },
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	try {
		for (const path of [
			"/v1/gmail/search",
			"/v1/gmail/read",
			"/v1/gmail/draft",
			"/v1/gmail/send",
			"/v1/outbound/gmail",
		]) {
			const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			assert.equal(response.status, 503, path);
			assert.deepEqual(
				await response.json(),
				{ error: path === "/v1/outbound/gmail" ? "gmail_unavailable" : "gmail_tools_unavailable" },
				path,
			);
		}
		assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM gmail_drafts").get().count, 0);
		assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM gmail_tool_requests").get().count, 0);
		assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM outbox").get().count, 0);
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
		mcp: {
			publicBaseUrl: "https://mcp.example.com/mcp",
			handoffBaseUrl: "https://app.example.com/connect",
			handoffTtlSeconds: 3600,
		},
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
	store.createContext({
		id: ownerRoute.contextId,
		targetId: target.id,
		driver: "oci",
		runtimeName: "owner-runtime",
		port: 32001,
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
	const mcp = new HostMcp({ config, store, routingKey });
	const handoff = mcp.createHandoff(target, owner.contextId, {
		direction: "inbound",
		name: "Scoped caller",
	});
	const oneTimeToken = new URL(handoff.url).searchParams.get("v");
	const sessionToken = mcp.openHandoff(oneTimeToken).session_token;
	const connected = await mcp.completeHandoff(sessionToken, { name: "Scoped caller" });
	const grantId = new URL(connected.server_url).pathname.split("/").at(-1);
	const grant = store.getMcpInboundGrant(grantId);
	const relationship = store.getMcpRelationship(grant.relationshipId);
	mcp.enqueueInstruction(grant, relationship, {
		message: "Send one bounded acceptance message.",
		idempotency_key: "server-scope-0001",
	});
	const notification = store.claimControlNotification();
	store.completeControlNotification(notification.id, "zulip-scope-message");
	const claimed = store.claimNextEvent();
	store.acceptEvent(claimed.id, claimed.leaseToken);
	store.heartbeatEvent(claimed.id, claimed.leaseToken);
	const sends = [];
	const mattermostCalls = [];
	const server = createHostServer({
		config,
		store,
		mcp,
		daemon: {
			polling: false,
			controlNotifier: { wake() {} },
		},
		phoneGateway: {
			async sendDirect(selected, body) {
				sends.push({ threadTarget: selected.threadTarget, body });
				if (body === "Ambiguous provider result.") {
					throw new PhoneDeliveryUncertainError("synthetic timeout after provider acceptance");
				}
				return { providerMessageId: `phone-sent-${sends.length}`, status: "queued" };
			},
		},
		mattermostGateway: {
			async proxy() { mattermostCalls.push("called"); },
		},
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const postAs = (contextId, body) => fetch(`${base}/v1/outbound/phone`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${contextCapability(target.outboundToken, "outbound", contextId)}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const post = (body) => postAs(owner.contextId, body);

	try {
		const mcpControl = await fetch(`${base}/v1/mcp/control`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${contextCapability(target.outboundToken, "mcp-control", owner.contextId)}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ action: "list", context_id: owner.contextId }),
		});
		assert.equal(mcpControl.status, 403);

		const otherChannel = await fetch(`${base}/v1/mattermost/${encodeURIComponent(owner.contextId)}/api/v4/posts`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${contextCapability(target.outboundToken, "mattermost", owner.contextId)}`,
				"content-type": "application/json",
			},
			body: "{}",
		});
		assert.equal(otherChannel.status, 403);
		assert.equal(mattermostCalls.length, 0);

		const unknown = await post({
			context_id: owner.contextId,
			thread_target: "phone-aaaaaaaaaaaaaaaaaaaa",
			agent_body: "Unknown conversation attempt.",
			idempotency_key: "phone-unknown",
			origin_event_id: claimed.id,
		});
		assert.equal(unknown.status, 403);
		assert.deepEqual(await unknown.json(), { error: "conversation_scope_denied" });
		assert.equal(sends.length, 0);

		const denied = await post({
			context_id: owner.contextId,
			thread_target: stranger.threadTarget,
			agent_body: "Cross-context attempt.",
			idempotency_key: "phone-denied",
			origin_event_id: claimed.id,
		});
		assert.equal(denied.status, 403);
		assert.deepEqual(await denied.json(), { error: "conversation_scope_denied" });
		assert.equal(sends.length, 0);

		const sent = await post({
			context_id: owner.contextId,
			thread_target: owner.threadTarget,
			agent_body: "A direct agent-authored reply.",
			idempotency_key: "phone-owner-reply",
			origin_event_id: claimed.id,
		});
		assert.equal(sent.status, 200);
		assert.deepEqual(sends, [{
			threadTarget: owner.threadTarget,
			body: "A direct agent-authored reply.",
		}]);
		assert.deepEqual(store.listProviderReceiptsForEvent(claimed.id).map((receipt) => ({
			providerMessageId: receipt.providerMessageId,
			providerStatus: receipt.providerStatus,
			hostStatus: receipt.hostStatus,
		})), [{ providerMessageId: "phone-sent-1", providerStatus: "queued", hostStatus: "completed" }]);
		const receiptResult = await mcp.proxyInbound({
			resourceId: grant.id,
			authorization: `Bearer ${connected.api_key}`,
			requestHeaders: { "content-type": "application/json" },
			body: Buffer.from(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "message_tinyfat",
					arguments: {
						message: "Send one bounded acceptance message.",
						idempotency_key: "server-scope-0001",
					},
				},
			})),
		});
		assert.deepEqual((await receiptResult.json()).result.structuredContent.provider_receipts, [{
			provider_message_id: "phone-sent-1",
			provider_status: "queued",
			host_status: "completed",
			completed_at: store.listProviderReceiptsForEvent(claimed.id)[0].completedAt,
		}]);

		const duplicate = await post({
			context_id: owner.contextId,
			thread_target: owner.threadTarget,
			agent_body: "A direct agent-authored reply.",
			idempotency_key: "phone-owner-reply",
			origin_event_id: claimed.id,
		});
		assert.equal(duplicate.status, 200);
		assert.equal(sends.length, 1);

		const uncertain = await postAs(stranger.contextId, {
			context_id: stranger.contextId,
			thread_target: stranger.threadTarget,
			agent_body: "Ambiguous provider result.",
			idempotency_key: "phone-uncertain",
		});
		assert.equal(uncertain.status, 409);
		assert.deepEqual(await uncertain.json(), { error: "delivery_result_uncertain" });
		assert.equal(sends.length, 2);

		const uncertainRetry = await postAs(stranger.contextId, {
			context_id: stranger.contextId,
			thread_target: stranger.threadTarget,
			agent_body: "Ambiguous provider result.",
			idempotency_key: "phone-uncertain",
		});
		assert.equal(uncertainRetry.status, 409);
		assert.deepEqual(await uncertainRetry.json(), { error: "delivery_result_uncertain" });
		assert.equal(sends.length, 2);

		const secondBody = await post({
			context_id: owner.contextId,
			thread_target: owner.threadTarget,
			agent_body: "A different second message must not leave this instruction.",
			idempotency_key: "phone-owner-second-body",
			origin_event_id: claimed.id,
		});
		assert.equal(secondBody.status, 409);
		assert.deepEqual(await secondBody.json(), {
			error: "relationship_instruction_delivery_already_exists",
		});
		assert.equal(sends.length, 2);
		assert.equal(store.listProviderReceiptsForEvent(claimed.id).length, 1);

		await mcp.revoke(owner.contextId, { direction: "inbound", id: grant.id });
		const revoked = await post({
			context_id: owner.contextId,
			thread_target: owner.threadTarget,
			agent_body: "Must be denied after revocation.",
			idempotency_key: "phone-after-revoke",
			origin_event_id: claimed.id,
		});
		assert.equal(revoked.status, 403);
		assert.equal(sends.length, 2);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
