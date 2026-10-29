import assert from "node:assert/strict";
import test from "node:test";
import { LocalChatModelGateway } from "../src/local-chat-model.mjs";

function config(overrides = {}) {
	return {
		phone: {
			apiAgent: {
				localModels: [{
					id: "example-local",
					displayName: "Example Local",
					providerModel: "example/local-model",
					baseUrl: "http://127.0.0.1:19043/v1",
					apiKey: "synthetic-local-gateway-token-at-least-32-bytes",
					maximumOutputTokens: 150,
					repetitionPenalty: 1.1,
					requestTimeoutMs: 10_000,
					maximumRequestBytes: 64 * 1024,
					...overrides,
				}],
			},
		},
	};
}

test("local chat uses one authenticated pinned short completion without tools", async () => {
	let calls = 0;
	const gateway = new LocalChatModelGateway({
		config: config(),
		fetchImpl: async (url, options) => {
			calls += 1;
			assert.equal(url, "http://127.0.0.1:19043/v1/chat/completions");
			assert.equal(options.method, "POST");
			assert.equal(
				options.headers.authorization,
				"Bearer synthetic-local-gateway-token-at-least-32-bytes",
			);
			const body = JSON.parse(options.body);
			assert.deepEqual(body, {
				model: "example/local-model",
				messages: [
					{ role: "system", content: "Stay concise." },
					{ role: "user", content: "Howdy" },
				],
				stream: false,
				max_tokens: 150,
				repetition_penalty: 1.1,
			});
			assert.equal("tools" in body, false);
			return Response.json({
				model: "example/local-model",
				choices: [{ message: { role: "assistant", content: "Example reply." } }],
			});
		},
	});
	assert.equal(gateway.has("example-local"), true);
	assert.equal(gateway.has("other"), false);
	assert.equal(
		await gateway.complete("example-local", [
			{ role: "system", content: "Stay concise." },
			{ role: "user", content: "Howdy" },
		]),
		"Example reply.",
	);
	assert.equal(calls, 1);
});

test("local chat fails closed on identity mismatch, oversized requests, and uncertain transport", async () => {
	const mismatch = new LocalChatModelGateway({
		config: config(),
		fetchImpl: async () => Response.json({
			model: "example/wrong-model",
			choices: [{ message: { content: "Wrong" } }],
		}),
	});
	await assert.rejects(
		mismatch.complete("example-local", [{ role: "user", content: "Hello" }]),
		(error) => error?.code === "local_model_identity_mismatch",
	);

	let oversizedCalls = 0;
	const oversized = new LocalChatModelGateway({
		config: config({ maximumRequestBytes: 1024 }),
		fetchImpl: async () => { oversizedCalls += 1; return Response.json({}); },
	});
	await assert.rejects(
		oversized.complete("example-local", [{ role: "user", content: "x".repeat(2000) }]),
		(error) => error?.code === "local_model_request_too_large",
	);
	assert.equal(oversizedCalls, 0);

	const uncertain = new LocalChatModelGateway({
		config: config(),
		fetchImpl: async () => { throw new TypeError("synthetic connection loss"); },
	});
	await assert.rejects(
		uncertain.complete("example-local", [{ role: "user", content: "Hello" }]),
		(error) => error?.code === "local_model_result_uncertain",
	);
});
