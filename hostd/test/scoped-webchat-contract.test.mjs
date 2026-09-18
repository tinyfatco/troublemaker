import assert from "node:assert/strict";
import test from "node:test";
import {
	SCOPED_WEBCHAT_PROTOCOL,
	ScopedWebchatContractError,
	validateScopedWebchatEnvelope,
} from "../src/scoped-webchat-contract.mjs";

const NOW = Date.parse("2026-01-01T00:00:10.000Z");
const SCOPE = {
	leaseId: "6f77f5fa-9375-4341-801c-f17e7814fa70",
	accountId: "example-org",
	userId: "example-user",
	membershipId: "example-member",
	membershipVersion: 4,
	role: "member",
	authorizedAt: "2026-01-01T00:00:00.000Z",
	expiresAt: "2026-01-01T00:00:20.000Z",
};
const REQUEST_ID = "124c2ca1-72ad-4f8b-b806-9a34266129f1";
const AGENT_ID = "53460db5-261e-5f5f-a6b1-2026a11ce001";

function envelope(action, payload = {}) {
	return action === "bootstrap"
		? { version: SCOPED_WEBCHAT_PROTOCOL, requestId: REQUEST_ID, scope: SCOPE }
		: { version: SCOPED_WEBCHAT_PROTOCOL, requestId: REQUEST_ID, scope: SCOPE, agentId: AGENT_ID, payload };
}

function rejects(action, value) {
	assert.throws(
		() => validateScopedWebchatEnvelope(value, action, { now: NOW }),
		(error) => error instanceof ScopedWebchatContractError,
	);
}

test("validates exact bootstrap, backlog, stream, and message shapes", () => {
	assert.equal(validateScopedWebchatEnvelope(envelope("bootstrap"), "bootstrap", { now: NOW }).scope.accountId, "example-org");
	assert.deepEqual(
		validateScopedWebchatEnvelope(envelope("events", { limit: 20, before: 10 }), "events", { now: NOW }).payload,
		{ limit: 20, before: 10 },
	);
	assert.deepEqual(
		validateScopedWebchatEnvelope(envelope("live", { after: 3 }), "live", { now: NOW }).payload,
		{ after: 3 },
	);
	assert.deepEqual(
		validateScopedWebchatEnvelope(envelope("messages", {
			message: "  Synthetic hello  ",
			source: "browser",
			sourceEventType: "synthetic",
			channelId: "ignored-browser-channel",
			fresh_context: false,
			session_id: "synthetic-session",
		}), "messages", { now: NOW }).payload,
		{
			message: "Synthetic hello",
			source: "browser",
			sourceEventType: "synthetic",
			channelId: "ignored-browser-channel",
			fresh_context: false,
			session_id: "synthetic-session",
		},
	);
});

test("rejects browser credentials, unknown fields, malformed agents, and stale leases", () => {
	rejects("bootstrap", { ...envelope("bootstrap"), agentId: AGENT_ID });
	rejects("status", { ...envelope("status"), payload: { embed_token: "synthetic" } });
	rejects("messages", envelope("messages", { message: "Synthetic", project: { slug: "escape" } }));
	rejects("messages", { ...envelope("messages", { message: "Synthetic" }), agentId: "not-an-agent" });
	rejects("messages", {
		...envelope("messages", { message: "Synthetic" }),
		scope: { ...SCOPE, expiresAt: "2026-01-01T00:00:05.000Z" },
	});
});
