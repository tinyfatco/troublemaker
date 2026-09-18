import assert from "node:assert/strict";
import { createServer } from "node:net";
import { Gateway } from "../src/gateway.js";
import { LocalDuplexIngress } from "../src/local-duplex-ingress.js";
import type { LocalDuplexTranscriptTurn } from "../src/agent.js";

async function availablePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			assert(address && typeof address !== "string");
			const port = address.port;
			server.close((error) => error ? reject(error) : resolve(port));
		});
	});
}

const turns: LocalDuplexTranscriptTurn[] = [];
const closed: string[] = [];
const ingress = new LocalDuplexIngress({
	append: async turn => { turns.push(turn); },
	close: async sessionId => { closed.push(sessionId); },
	observe: turn => { turns.push(turn); },
	closeObservation: id => { closed.push(id); },
});
const gateway = new Gateway({ consoleToken: "synthetic-console-token-0123456789" });
const path = "/api/v2/agents/current/local-duplex";
gateway.register(path, (req, res) => ingress.dispatch(req, res));
gateway.registerGet(path, (req, res) => ingress.dispatch(req, res));
gateway.markReady(path);
const port = await availablePort();
await gateway.start(port, "127.0.0.1");

try {
	const url = `http://127.0.0.1:${port}${path}`;
	const capability = await fetch(url, { headers: { authorization: "Bearer synthetic-console-token-0123456789" } });
	assert.equal(capability.status, 200);
	assert.equal((await capability.json()).live_observations, true);
	const payload = {
		type: "transcript",
		session_id: "synthetic-session",
		sequence: 0,
		role: "user",
		text: "Synthetic exact text.",
		timestamp_ms: 1_800_000_000_000,
	};
	const unauthorized = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	assert.equal(unauthorized.status, 401);
	assert.equal(turns.length, 0);

	const authorized = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer synthetic-console-token-0123456789",
		},
		body: JSON.stringify(payload),
	});
	assert.equal(authorized.status, 200);
	assert.deepEqual(turns, [{
		sessionId: payload.session_id,
		sequence: payload.sequence,
		role: payload.role,
		text: payload.text,
		timestamp: payload.timestamp_ms,
	}]);

	const closedResponse = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer synthetic-console-token-0123456789",
		},
		body: JSON.stringify({ type: "session.closed", session_id: payload.session_id }),
	});
	assert.equal(closedResponse.status, 200);
	assert.deepEqual(closed, [payload.session_id]);
	assert.equal((await closedResponse.json()).live_observations, true);
	const observation = await fetch(url, {
		method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-console-token-0123456789" },
		body: JSON.stringify({ ...payload, type: "transcript.observation", session_id: "synthetic-live", role: "user" }),
	});
	assert.equal(observation.status, 200);
	assert.equal(turns.at(-1)?.observation, true);
	const invalid = await fetch(url, {
		method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-console-token-0123456789" },
		body: JSON.stringify({ ...payload, type: "transcript.observation", role: "assistant" }),
	});
	assert.equal(invalid.status, 400);
	console.log("local duplex ingress: ok");
} finally {
	await gateway.stop();
}
