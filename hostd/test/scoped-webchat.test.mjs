import assert from "node:assert/strict";
import test from "node:test";
import { ScopedWebchat } from "../src/scoped-webchat.mjs";

const SCOPE = {
	leaseId: "6f77f5fa-9375-4341-801c-f17e7814fa70",
	accountId: "example-org",
	userId: "example-user",
	membershipId: "example-member",
	membershipVersion: 4,
	role: "member",
	authorizedAt: "2026-01-01T00:00:00.000Z",
	expiresAt: "2099-01-01T00:00:20.000Z",
};
const KEYS = {
	accountKey: "a".repeat(40),
	userKey: "b".repeat(40),
	membershipKey: "c".repeat(40),
	principalKey: "d".repeat(40),
	contextId: `example-target:${"d".repeat(40)}:scoped-app`,
};
const TARGET = {
	id: "example-target",
	inboundToken: "synthetic-inbound-capability-at-least-32-bytes",
	outboundToken: "synthetic-outbound-capability-at-least-32-bytes",
};

function fixture({ renewFailureAfter = Number.POSITIVE_INFINITY, renewalIntervalMs = 8_000 } = {}) {
	const requests = [];
	const stops = [];
	let renewals = 0;
	const gateway = {
		async renewScope(scope) {
			renewals += 1;
			if (renewals > renewFailureAfter) throw new Error("synthetic_lease_revoked");
			return { scope: { ...scope }, keys: { ...KEYS } };
		},
		async materializeOrganizationContext(accountKey) {
			assert.equal(accountKey, KEYS.accountKey);
			return { path: `/example/${accountKey}/CONTEXT.md`, revision: 1, sha256: "e".repeat(64), organizationKey: accountKey };
		},
	};
	const runtime = {
		async ensureScopedOciContext(target, contextId, organization) {
			assert.equal(target, TARGET);
			assert.equal(contextId, KEYS.contextId);
			assert.equal(organization.organizationKey, KEYS.accountKey);
			return { port: 34567 };
		},
		async stopScopedOciContext(target, contextId) { stops.push({ target, contextId }); },
	};
	const fetchImpl = async (url, init = {}) => {
		requests.push({ url: String(url), init });
		if (String(url).endsWith("/messages/stop")) {
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (String(url).includes("/events") && !String(url).endsWith("/events/stream")) {
			return new Response(JSON.stringify({ lines: [], total: 0, offset: 0 }), { status: 200, headers: { "content-type": "application/json" } });
		}
		return new Response("data: {\"type\":\"status\",\"status\":\"accepted\"}\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const subject = new ScopedWebchat({
		config: {
			server: { port: 3099 },
			openAi: {
				scope: { mode: "all", contextIds: [] },
				defaultModel: "gpt-5.6-luna",
				contextModels: {},
				maximumOutputTokens: 32_768,
			},
		},
		gateway,
		store: { activeTurnsForContext: () => [] },
		runtime,
		routingKey: Buffer.alloc(32, 7),
		target: TARGET,
		fetchImpl,
		renewalIntervalMs,
		idleStopDelayMs: 5,
	});
	return { subject, requests, stops };
}

function envelope(agentId, payload = {}) {
	return {
		version: "vectors.webchat.v1",
		requestId: "124c2ca1-72ad-4f8b-b806-9a34266129f1",
		scope: { ...SCOPE },
		...(agentId ? { agentId, payload } : {}),
	};
}

test("bootstrap binds one opaque agent to exact Luna xhigh and embed-only capabilities", async () => {
	const { subject } = fixture();
	try {
		const first = await subject.bootstrap(envelope());
		const second = await subject.bootstrap(envelope());
		assert.match(first.agentId, /^[0-9a-f-]{36}$/);
		assert.equal(first.agentId, second.agentId);
		assert.deepEqual(first.model, { provider: "openai", id: "gpt-5.6-luna", thinking: "xhigh", exact: true });
		assert.deepEqual(first.capabilities, {
			messages: true, awareness: true, cancellation: true,
			files: false, terminal: false, desktop: false, voice: false,
			calendar: false, display: false, embed: true,
		});
		const status = await subject.status(envelope(first.agentId));
		assert.equal(status.agent_id, first.agentId);
		assert.equal(status.capabilities.embed, true);
		await assert.rejects(subject.status(envelope("53460db5-261e-5f5f-a6b1-2026a11ce001")), (error) => error?.status === 404);
	} finally {
		await subject.shutdown();
	}
});

test("message proxy pins scope, streams natively, and performs real cancellation", async () => {
	const { subject, requests } = fixture();
	try {
		const { agentId } = await subject.bootstrap(envelope());
		const proxy = await subject.proxy(envelope(agentId, {
			message: "Synthetic hello",
			source: "untrusted-source",
			sourceEventType: "untrusted-event",
			channelId: "untrusted-channel",
		}), "messages");
		assert.equal(proxy.upstream.headers.get("content-type"), "text/event-stream");
		const sent = JSON.parse(String(requests[0].init.body));
		assert.equal(sent.message, "Synthetic hello");
		assert.equal(sent.source, "web");
		assert.equal(sent.sourceEventType, "scoped_webchat");
		assert.equal(sent.channelId, `scoped-webchat:${KEYS.accountKey}`);
		assert.equal(sent.deliveryId, envelope().requestId);
		assert.doesNotMatch(JSON.stringify(sent), /untrusted/);
		assert.deepEqual(await subject.stop(envelope(agentId)), { ok: true, cancelled: true });
		assert.match(requests[1].url, /messages\/stop$/);
		await proxy.close();
	} finally {
		await subject.shutdown();
	}
});

test("an early browser message-stream disconnect stops model work", async () => {
	const { subject, requests } = fixture();
	try {
		const { agentId } = await subject.bootstrap(envelope());
		const proxy = await subject.proxy(envelope(agentId, { message: "Synthetic long task" }), "messages");
		await proxy.close();
		assert.equal(requests.some((request) => request.url.endsWith("/messages/stop")), true);
	} finally {
		await subject.shutdown();
	}
});

test("membership revocation aborts all native streams and unmounts the context", async () => {
	const { subject, stops } = fixture();
	try {
		const { agentId } = await subject.bootstrap(envelope());
		const proxy = await subject.proxy(envelope(agentId), "events-stream");
		await subject.revokeMembership(KEYS.accountKey, KEYS.membershipKey, SCOPE.membershipVersion);
		assert.equal(stops.some((row) => row.contextId === KEYS.contextId), true);
		await proxy.close();
	} finally {
		await subject.shutdown();
	}
});

test("an already-open SSE stream is revoked when its periodic membership renewal fails", async () => {
	const { subject, stops } = fixture({ renewFailureAfter: 3, renewalIntervalMs: 5 });
	try {
		const { agentId } = await subject.bootstrap(envelope());
		const proxy = await subject.proxy(envelope(agentId), "events-stream");
		for (let attempt = 0; attempt < 40 && !proxy.signal.aborted; attempt += 1) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
		}
		assert.equal(proxy.signal.aborted, true);
		assert.equal(stops.some((row) => row.contextId === KEYS.contextId), true);
		await proxy.close();
	} finally {
		await subject.shutdown();
	}
});
