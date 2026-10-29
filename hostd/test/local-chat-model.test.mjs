import assert from "node:assert/strict";
import test from "node:test";
import { LocalChatModelGateway } from "../src/local-chat-model.mjs";

const CATALOG = [
	{ id: "example-alpha", name: "Example Alpha", about: "A synthetic first catalog entry." },
	{ id: "example-beta", name: "Example Beta", about: "A synthetic second catalog entry." },
];

function config(overrides = {}) {
	return {
		phone: {
			apiAgent: {
				localCatalog: {
					baseUrl: "http://127.0.0.1:19043/v1",
					apiKey: "synthetic-local-gateway-token-at-least-32-bytes",
					maximumOutputTokens: 150,
					repetitionPenalty: 1.1,
					requestTimeoutMs: 10_000,
					maximumRequestBytes: 64 * 1024,
					maximumCatalogBytes: 64 * 1024,
					maximumModels: 16,
					...overrides,
				},
			},
		},
	};
}

function catalogResponse(models = CATALOG) {
	return Response.json({ data: models });
}

test("local chat reads an authenticated catalog and sends only minimal selected-model messages", async () => {
	const calls = [];
	const gateway = new LocalChatModelGateway({
		config: config(),
		fetchImpl: async (url, options = {}) => {
			calls.push({ url, options });
			assert.equal(options.headers.authorization, "Bearer synthetic-local-gateway-token-at-least-32-bytes");
			if (url.endsWith("/models")) return catalogResponse();
			assert.equal(url, "http://127.0.0.1:19043/v1/chat/completions");
			assert.equal(options.method, "POST");
			const body = JSON.parse(options.body);
			assert.deepEqual(body, {
				model: "example-beta",
				messages: [
					{ role: "user", content: "Howdy" },
					{ role: "assistant", content: "Hello" },
					{ role: "user", content: "Again" },
				],
				stream: false,
				max_tokens: 150,
				repetition_penalty: 1.1,
			});
			assert.equal("tools" in body, false);
			return Response.json({
				model: "example-beta",
				choices: [{ message: { role: "assistant", content: "Example reply." } }],
			});
		},
	});
	assert.deepEqual(await gateway.listModels(), CATALOG);
	assert.equal(
		await gateway.complete("example-beta", [
			{ role: "user", content: "Howdy" },
			{ role: "assistant", content: "Hello" },
			{ role: "user", content: "Again" },
		]),
		"Example reply.",
	);
	assert.equal(calls.length, 3);
});

test("local catalog and chat fail closed on malformed identity, prompts, bounds, and transport", async () => {
	const malformedCatalog = new LocalChatModelGateway({
		config: config(),
		fetchImpl: async () => catalogResponse([
			{ id: "Example Alpha", name: "Bad", about: "Invalid ID" },
		]),
	});
	await assert.rejects(
		malformedCatalog.listModels(),
		(error) => error?.code === "local_model_catalog_invalid",
	);

	const duplicateName = new LocalChatModelGateway({
		config: config(),
		fetchImpl: async () => catalogResponse([
			{ id: "example-alpha", name: "Same Name", about: "First" },
			{ id: "example-beta", name: "same name", about: "Second" },
		]),
	});
	await assert.rejects(
		duplicateName.listModels(),
		(error) => error?.code === "local_model_catalog_invalid",
	);

	const mismatch = new LocalChatModelGateway({
		config: config(),
		fetchImpl: async (url) => url.endsWith("/models")
			? catalogResponse()
			: Response.json({
				model: "example-alpha",
				choices: [{ message: { content: "Wrong" } }],
			}),
	});
	await assert.rejects(
		mismatch.complete("example-beta", [{ role: "user", content: "Hello" }]),
		(error) => error?.code === "local_model_identity_mismatch",
	);
	await assert.rejects(
		mismatch.complete("example-beta", [{ role: "system", content: "Not allowed" }], undefined, { catalog: CATALOG }),
		(error) => error?.code === "local_model_input_invalid",
	);

	let oversizedCalls = 0;
	const oversized = new LocalChatModelGateway({
		config: config({ maximumRequestBytes: 1024 }),
		fetchImpl: async () => { oversizedCalls += 1; return Response.json({}); },
	});
	await assert.rejects(
		oversized.complete(
			"example-beta",
			[{ role: "user", content: "x".repeat(2000) }],
			undefined,
			{ catalog: CATALOG },
		),
		(error) => error?.code === "local_model_request_too_large",
	);
	assert.equal(oversizedCalls, 0);

	const uncertain = new LocalChatModelGateway({
		config: config(),
		fetchImpl: async () => { throw new TypeError("synthetic connection loss"); },
	});
	await assert.rejects(
		uncertain.listModels(),
		(error) => error?.code === "local_model_result_uncertain",
	);
});
