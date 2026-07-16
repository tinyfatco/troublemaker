import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordGatewayAdapter } from "../src/adapters/discord-gateway.js";

// Synthetic Discord-shaped fixtures; none identify a real account or deployment.
const BOT_ID = "100000000000000001";
const CHANNEL_ID = "200000000000000002";
const MESSAGE_ID = "300000000000000003";
const workingDir = mkdtempSync(join(tmpdir(), "tm-discord-rest-"));

function jsonResponse(status: number, body: object, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

try {
	let calls = 0;
	const delays: number[] = [];
	const authHeaders: string[] = [];
	const retrying = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		rest: {
			fetch: (async (_input, init) => {
				calls++;
				authHeaders.push(new Headers(init?.headers).get("authorization") || "");
				if (calls === 1) return jsonResponse(429, { retry_after: 0.01 }, { "retry-after": "0.01" });
				return jsonResponse(200, { id: MESSAGE_ID });
			}) as typeof fetch,
			sleep: async (delay) => { delays.push(delay); },
			maxRateLimitRetries: 2,
		},
	});

	assert.equal(await retrying.postMessage(CHANNEL_ID, "hello"), MESSAGE_ID);
	assert.equal(calls, 2);
	assert.deepEqual(delays, [10]);
	assert.deepEqual(authHeaders, ["Bot test-bot-token", "Bot test-bot-token"]);

	let bodyOnlyCalls = 0;
	const bodyOnlyDelays: number[] = [];
	const bodyOnlyRetry = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		rest: {
			fetch: (async () => {
				bodyOnlyCalls++;
				return bodyOnlyCalls === 1
					? jsonResponse(429, { retry_after: 0.002 })
					: jsonResponse(200, { id: MESSAGE_ID });
			}) as typeof fetch,
			sleep: async (delay) => { bodyOnlyDelays.push(delay); },
		},
	});
	assert.equal(await bodyOnlyRetry.postMessage(CHANNEL_ID, "body retry delay"), MESSAGE_ID);
	assert.deepEqual(bodyOnlyDelays, [2], "retry_after JSON is honored when the header is absent");

	let boundedCalls = 0;
	const boundedDelays: number[] = [];
	const bounded = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		rest: {
			fetch: (async () => {
				boundedCalls++;
				return jsonResponse(429, { retry_after: 0.001 }, { "retry-after": "0.001" });
			}) as typeof fetch,
			sleep: async (delay) => { boundedDelays.push(delay); },
			maxRateLimitRetries: 2,
		},
	});
	await assert.rejects(
		() => bounded.postMessage(CHANNEL_ID, "bounded"),
		/Discord REST POST \/channels\/:id\/messages returned HTTP 429 after 3 attempts/,
	);
	assert.equal(boundedCalls, 3, "429 retries stop at the configured bound");
	assert.deepEqual(boundedDelays, [1, 1]);

	let unsafeDelayCalls = 0;
	const unsafeDelay = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		rest: {
			fetch: (async () => {
				unsafeDelayCalls++;
				return jsonResponse(429, { retry_after: 120 }, { "retry-after": "120" });
			}) as typeof fetch,
			sleep: async () => { throw new Error("unsafe delay must not sleep"); },
			maxRetryAfterMs: 1000,
		},
	});
	await assert.rejects(
		() => unsafeDelay.postMessage(CHANNEL_ID, "do not retry early"),
		/Discord REST POST \/channels\/:id\/messages returned HTTP 429 with an unusable retry delay/,
	);
	assert.equal(unsafeDelayCalls, 1, "a retry-after beyond the configured bound fails instead of retrying early");

	const httpFailure = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		rest: {
			fetch: (async () => jsonResponse(403, { message: "synthetic response body must stay private" })) as typeof fetch,
		},
	});
	await assert.rejects(
		() => httpFailure.postMessage(CHANNEL_ID, "rejected send"),
		(error: Error) => {
			assert.match(error.message, /Discord REST POST \/channels\/:id\/messages returned HTTP 403/);
			assert.doesNotMatch(error.message, /synthetic response body/);
			return true;
		},
	);

	const invalidSuccess = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		rest: {
			fetch: (async () => jsonResponse(200, { accepted: true })) as typeof fetch,
		},
	});
	await assert.rejects(
		() => invalidSuccess.postMessage(CHANNEL_ID, "missing message id"),
		/Discord REST returned an invalid message response/,
	);

	let networkCalls = 0;
	const networkFailure = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		rest: {
			fetch: (async () => {
				networkCalls++;
				throw new TypeError("synthetic network failure");
			}) as typeof fetch,
		},
	});
	await assert.rejects(() => networkFailure.postMessage(CHANNEL_ID, "network failure"), /Discord REST POST \/channels\/:id\/messages failed/);
	assert.equal(networkCalls, 1, "unsafe blind retries are not used for ambiguous POST failures");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("discord-rest ok");
