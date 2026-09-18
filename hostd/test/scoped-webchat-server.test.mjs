import assert from "node:assert/strict";
import test from "node:test";
import { createScopedAppServer } from "../src/scoped-app-server.mjs";

const TOKEN = "synthetic-webchat-capability-at-least-32-bytes";
const AGENT_ID = "53460db5-261e-5f5f-a6b1-2026a11ce001";

function scope() {
	const now = Date.now();
	return {
		leaseId: "6f77f5fa-9375-4341-801c-f17e7814fa70",
		accountId: "example-org",
		userId: "example-user",
		membershipId: "example-member",
		membershipVersion: 4,
		role: "member",
		authorizedAt: new Date(now - 100).toISOString(),
		expiresAt: new Date(now + 20_000).toISOString(),
	};
}

function body(action, payload = {}) {
	const base = { version: "vectors.webchat.v1", requestId: "124c2ca1-72ad-4f8b-b806-9a34266129f1", scope: scope() };
	return action === "bootstrap" ? base : { ...base, agentId: AGENT_ID, payload };
}

async function fixture() {
	const calls = [];
	const webchat = {
		async bootstrap(envelope) {
			calls.push({ action: "bootstrap", envelope });
			return { version: "vectors.webchat.v1", agentId: AGENT_ID, expiresAt: envelope.scope.expiresAt, model: { provider: "openai", id: "gpt-5.6-luna", thinking: "xhigh", exact: true }, capabilities: { embed: true } };
		},
		async status(envelope) {
			calls.push({ action: "status", envelope });
			return { agent_id: AGENT_ID, mode: "hosted", display_mode: "terminal", agent_name: "Example", capabilities: { embed: true } };
		},
		async stop(envelope) { calls.push({ action: "messages-stop", envelope }); return { ok: true, cancelled: true }; },
		async proxy(envelope, action) {
			calls.push({ action, envelope });
			const upstream = action === "events"
				? new Response(JSON.stringify({ lines: [], total: 0, offset: 0 }), { status: 200, headers: { "content-type": "application/json" } })
				: new Response("data: {\"type\":\"status\",\"status\":\"accepted\"}\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
			return { upstream, close: async () => calls.push({ action: `${action}:closed` }) };
		},
	};
	const server = createScopedAppServer({
		config: { scopedApp: {
			dispatchPath: "/v1/example/dispatch",
			dispatchToken: "synthetic-dispatch-capability-at-least-32-bytes",
			revokeToken: "synthetic-revoke-capability-at-least-32-bytes",
			webchatPath: "/v1/example/webchat",
			webchatToken: TOKEN,
			maximumRequestBytes: 128 * 1024,
		} },
		gateway: { dispatch: async () => ({}), authorizeRuntime: async () => ({ ok: true }) },
		target: { inboundToken: "synthetic-inbound-capability-at-least-32-bytes" },
		webchat,
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	return { server, base: `http://127.0.0.1:${address.port}`, calls };
}

async function post(base, action, input, { token = TOKEN, origin } = {}) {
	return fetch(`${base}/v1/example/webchat/${action}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(origin ? { origin } : {}),
		},
		body: JSON.stringify(input),
	});
}

test("native webchat bridge is server-only, exact-action scoped, and preserves SSE bytes", async () => {
	const subject = await fixture();
	try {
		assert.equal((await post(subject.base, "bootstrap", body("bootstrap"), { token: "" })).status, 401);
		assert.equal((await post(subject.base, "bootstrap", body("bootstrap"), { origin: "https://app.example.com" })).status, 403);
		assert.equal((await post(subject.base, "unknown", body("bootstrap"))).status, 404);

		const bootstrap = await post(subject.base, "bootstrap", body("bootstrap"));
		assert.equal(bootstrap.status, 200);
		assert.equal((await bootstrap.json()).model.thinking, "xhigh");
		const status = await post(subject.base, "status", body("status"));
		assert.equal((await status.json()).agent_id, AGENT_ID);
		const events = await post(subject.base, "events", body("events", { limit: 50 }));
		assert.deepEqual(await events.json(), { lines: [], total: 0, offset: 0 });
		const stream = await post(subject.base, "messages", body("messages", { message: "Synthetic hello" }));
		assert.equal(stream.headers.get("content-type"), "text/event-stream");
		assert.equal(await stream.text(), "data: {\"type\":\"status\",\"status\":\"accepted\"}\n\ndata: [DONE]\n\n");
		assert.equal(subject.calls.some((call) => call.action === "messages:closed"), true);
		assert.deepEqual(await (await post(subject.base, "messages-stop", body("messages-stop"))).json(), { ok: true, cancelled: true });
	} finally {
		await new Promise((resolvePromise) => subject.server.close(resolvePromise));
	}
});
