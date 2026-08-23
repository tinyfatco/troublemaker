import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	HostOpenAi,
	openAiUsageMicrodollars,
	worstCaseOpenAiReservationMicrodollars,
} from "../src/openai.mjs";
import {
	HOSTD_OPENAI_MODEL,
	resolveContextRuntimeModel,
	runtimeModelEnvironment,
	runtimeModelVersionSuffix,
	validateOpenAiContextModels,
} from "../src/runtime-model.mjs";
import { contextCapability } from "../src/security.mjs";
import { createHostServer } from "../src/server.mjs";
import { HostStore } from "../src/store.mjs";

const CONTEXT_A = "front-desk:relationship-a";
const CONTEXT_B = "front-desk:relationship-b";
const SOL_MODEL = "gpt-5.6-sol";
const LUNA_MODEL = "gpt-5.6-luna";

function fixture(overrides = {}) {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-openai-"));
	const database = join(directory, "state.sqlite");
	const store = new HostStore(database);
	const target = {
		id: "front-desk",
		driver: "oci",
		inboundToken: "synthetic-inbound-secret",
		outboundToken: "synthetic-outbound-secret",
		hostGateway: "host.containers.internal",
	};
	const config = {
		server: { port: 3099 },
		scheduler: { maxConcurrent: 2 },
		routing: { knownPhonePrincipals: [] },
		openAi: {
			apiKey: "synthetic-organization-openai-key",
			scope: { mode: "all", contextIds: [] },
			defaultModel: LUNA_MODEL,
			contextModels: {},
			monthlySpendCapCents: 2500,
			maximumOutputTokens: 32_768,
			maximumConcurrentPerContext: 1,
			maximumConcurrentGlobal: 2,
			requestTimeoutMs: 10_000,
			maximumRequestBytes: 64 * 1024,
			...overrides,
		},
		workersAi: {
			accountId: "0123456789abcdef0123456789abcdef",
			allowedModels: ["@cf/zai-org/glm-5.2"],
		},
		targetsById: new Map([[target.id, target]]),
	};
	for (const contextId of [CONTEXT_A, CONTEXT_B]) {
		store.createContext({
			id: contextId,
			targetId: target.id,
			driver: "oci",
			runtimeName: contextId.replace(":", "-"),
			status: "running",
		});
	}
	return { directory, database, store, target, config };
}

function requestBody(overrides = {}) {
	const model = overrides.model ?? LUNA_MODEL;
	return {
		model,
		input: [{ role: "user", content: [{ type: "input_text", text: "Synthetic canary" }] }],
		stream: true,
		store: false,
		reasoning: {
			effort: model === LUNA_MODEL ? "max" : "xhigh",
			summary: "auto",
		},
		prompt_cache_key: "synthetic-session",
		include: ["reasoning.encrypted_content"],
		tools: [{ type: "function", name: "synthetic_check", parameters: { type: "object" } }],
		...overrides,
	};
}

function successfulResponse(model = LUNA_MODEL) {
	return new Response(
		'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
		+ `data: {"type":"response.completed","response":{"model":"${model}","usage":`
		+ '{"input_tokens":100,"input_tokens_details":{"cached_tokens":20,"cache_write_tokens":10},'
		+ '"output_tokens":25,"total_tokens":125}}}\n\n',
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function closeFixture(state) {
	state.store.close();
	rmSync(state.directory, { recursive: true, force: true });
}

test("Sol accounting reserves the published high-context worst case", () => {
	assert.equal(worstCaseOpenAiReservationMicrodollars(SOL_MODEL, 32_768), 11_483_040);
	assert.equal(worstCaseOpenAiReservationMicrodollars(SOL_MODEL, 128_000), 14_340_000);
	assert.equal(openAiUsageMicrodollars(SOL_MODEL, {
		inputTokens: 100,
		cachedInputTokens: 20,
		cacheWriteTokens: 10,
		outputTokens: 25,
	}), 838);
	assert.equal(openAiUsageMicrodollars(SOL_MODEL, {
		inputTokens: 300_000,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 1000,
	}), 2_430_000);
});

test("Luna accounting reserves the published high-context worst case", () => {
	assert.equal(worstCaseOpenAiReservationMicrodollars(LUNA_MODEL, 32_768), 583_983);
	assert.equal(worstCaseOpenAiReservationMicrodollars(LUNA_MODEL, 128_000), 755_400);
	assert.equal(openAiUsageMicrodollars(LUNA_MODEL, {
		inputTokens: 100,
		cachedInputTokens: 20,
		cacheWriteTokens: 10,
		outputTokens: 25,
	}), 48);
	assert.equal(openAiUsageMicrodollars(LUNA_MODEL, {
		inputTokens: 300_000,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 1000,
	}), 121_800);
});

test("the hard $25 monthly cap admits only 42 worst-case default Luna reservations", () => {
	const state = fixture();
	assert.equal(HOSTD_OPENAI_MODEL, LUNA_MODEL);
	const reservedMicrodollars = worstCaseOpenAiReservationMicrodollars(LUNA_MODEL, 32_768);
	const reserve = (id) => state.store.reserveOpenAiRequest({
		id,
		targetId: state.target.id,
		contextId: CONTEXT_A,
		model: HOSTD_OPENAI_MODEL,
		monthStartedAt: "2026-08-01T00:00:00.000Z",
		observedAt: "2026-08-15T12:00:00.000Z",
		expiresAt: "2026-08-15T12:10:00.000Z",
		reservedMicrodollars,
		monthlySpendCapCents: 2500,
		maximumConcurrentPerContext: 100,
		maximumConcurrentGlobal: 100,
	});
	try {
		for (let index = 0; index < 42; index += 1) {
			assert.equal(reserve(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`).allowed, true);
		}
		const rejected = reserve("00000000-0000-4000-8000-000000000042");
		assert.equal(rejected.allowed, false);
		assert.equal(rejected.code, "openai_monthly_spend_cap_exhausted");
		assert.equal(rejected.committedMicrodollars, 24_527_286);
		assert.equal(rejected.capMicrodollars, 25_000_000);
	} finally {
		closeFixture(state);
	}
});

test("Sol and Luna reservations share one durable monthly cap", () => {
	const state = fixture();
	const reserve = (id, model) => state.store.reserveOpenAiRequest({
		id,
		targetId: state.target.id,
		contextId: CONTEXT_A,
		model,
		monthStartedAt: "2026-08-01T00:00:00.000Z",
		observedAt: "2026-08-15T12:00:00.000Z",
		expiresAt: "2026-08-15T12:10:00.000Z",
		reservedMicrodollars: worstCaseOpenAiReservationMicrodollars(model, 32_768),
		monthlySpendCapCents: 2500,
		maximumConcurrentPerContext: 10,
		maximumConcurrentGlobal: 10,
	});
	try {
		assert.equal(reserve("00000000-0000-4000-8000-000000000021", SOL_MODEL).allowed, true);
		assert.equal(reserve("00000000-0000-4000-8000-000000000022", SOL_MODEL).allowed, true);
		assert.equal(reserve("00000000-0000-4000-8000-000000000023", LUNA_MODEL).allowed, true);
		assert.equal(reserve("00000000-0000-4000-8000-000000000024", LUNA_MODEL).allowed, true);
		assert.equal(reserve("00000000-0000-4000-8000-000000000025", LUNA_MODEL).allowed, true);
		const rejected = reserve("00000000-0000-4000-8000-000000000026", LUNA_MODEL);
		assert.equal(rejected.allowed, false);
		assert.equal(rejected.code, "openai_monthly_spend_cap_exhausted");
		assert.equal(rejected.committedMicrodollars, 24_718_029);
	} finally {
		closeFixture(state);
	}
});

test("OpenAI runtime selection defaults to Luna and preserves context-only proxy authority", () => {
	const state = fixture({ contextModels: { [CONTEXT_B]: SOL_MODEL } });
	try {
		validateOpenAiContextModels(state.config, state.store);
		const selected = resolveContextRuntimeModel(
			state.config,
			state.store,
			Buffer.alloc(32, 7),
			state.target,
			CONTEXT_A,
		);
		assert.deepEqual(selected, {
			provider: "openai",
			id: "gpt-5.6-luna",
			thinking: "max",
			maximumOutputTokens: 32_768,
		});
		const environment = runtimeModelEnvironment(
			state.config,
			state.target,
			CONTEXT_A,
			selected,
		);
		assert.deepEqual({
			provider: environment.MOM_MODEL_PROVIDER,
			model: environment.MOM_MODEL_ID,
			thinking: environment.MOM_THINKING,
			maximumOutputTokens: environment.MOM_MAX_OUTPUT_TOKENS,
			migrated: environment.TROUBLEMAKER_HOSTD_OPENAI_MIGRATED,
		}, {
			provider: "openai",
			model: "gpt-5.6-luna",
			thinking: "max",
			maximumOutputTokens: "32768",
			migrated: "1",
		});
		assert.equal(
			environment.OPENAI_BASE_URL,
			`http://host.containers.internal:3099/v1/openai/${encodeURIComponent(CONTEXT_A)}`,
		);
		assert.equal(
			environment.OPENAI_API_KEY,
			contextCapability(state.target.outboundToken, "openai", CONTEXT_A),
		);
		assert.notEqual(environment.OPENAI_API_KEY, state.config.openAi.apiKey);
		assert.notEqual(
			environment.OPENAI_API_KEY,
			contextCapability(state.target.outboundToken, "openai", CONTEXT_B),
		);
		assert.equal("OPENAI_CODEX_BASE_URL" in environment, false);
		assert.equal("CLOUDFLARE_API_KEY" in environment, false);
		assert.match(runtimeModelVersionSuffix(selected), /^:model-[0-9a-f]{12}$/);
		const sol = resolveContextRuntimeModel(
			state.config,
			state.store,
			Buffer.alloc(32, 7),
			state.target,
			CONTEXT_B,
		);
		assert.deepEqual(sol, {
			provider: "openai",
			id: SOL_MODEL,
			thinking: "xhigh",
			maximumOutputTokens: 32_768,
		});
		const solEnvironment = runtimeModelEnvironment(
			state.config,
			state.target,
			CONTEXT_B,
			sol,
		);
		assert.equal(solEnvironment.MOM_MODEL_ID, SOL_MODEL);
		assert.equal(solEnvironment.MOM_THINKING, "xhigh");
		assert.notEqual(runtimeModelVersionSuffix(sol), runtimeModelVersionSuffix(selected));

		state.config.openAi.contextModels["front-desk:missing"] = LUNA_MODEL;
		assert.throws(
			() => validateOpenAiContextModels(state.config, state.store),
			/references an unknown context/,
		);
		delete state.config.openAi.contextModels["front-desk:missing"];
		state.config.openAi.scope = { mode: "contexts", contextIds: [CONTEXT_A] };
		assert.equal(
			resolveContextRuntimeModel(
				state.config,
				state.store,
				Buffer.alloc(32, 7),
				state.target,
				CONTEXT_B,
			),
			undefined,
			"canary scope leaves every other context on its existing default and keeps Workers AI dormant",
		);
	} finally {
		closeFixture(state);
	}
});

test("synthetic no-customer-send canary enforces isolation, exact Luna model, max thinking, and output bounds", async () => {
	const state = fixture({ scope: { mode: "contexts", contextIds: [CONTEXT_A] } });
	const upstreamRequests = [];
	let customerSends = 0;
	const openAiGateway = new HostOpenAi({
		config: state.config,
		store: state.store,
		fetchImpl: async (input, init) => {
			upstreamRequests.push({
				url: String(input),
				headers: new Headers(init.headers),
				body: JSON.parse(String(init.body)),
			});
			return successfulResponse();
		},
	});
	const server = createHostServer({
		config: state.config,
		store: state.store,
		daemon: { polling: false },
		openAiGateway,
		phoneGateway: { sendDirect: async () => { customerSends += 1; } },
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const request = (contextId, token, body) => fetch(
		`http://127.0.0.1:${address.port}/v1/openai/${encodeURIComponent(contextId)}/responses`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	const tokenA = contextCapability(state.target.outboundToken, "openai", CONTEXT_A);
	const tokenB = contextCapability(state.target.outboundToken, "openai", CONTEXT_B);
	try {
		assert.equal((await request(CONTEXT_A, "wrong", requestBody())).status, 401);
		assert.equal((await request(CONTEXT_B, tokenA, requestBody())).status, 401);
		assert.equal((await request(CONTEXT_B, tokenB, requestBody())).status, 403);
		for (const body of [
			requestBody({ model: "gpt-5.6-sol" }),
			requestBody({ reasoning: { effort: "high" } }),
			requestBody({ reasoning: { effort: "xhigh" } }),
			requestBody({ max_output_tokens: 32_769 }),
			requestBody({ tools: [{ type: "web_search" }] }),
			requestBody({ tool_choice: { type: "web_search" } }),
		]) {
			assert.ok([400, 403].includes((await request(CONTEXT_A, tokenA, body)).status));
		}
		assert.equal(upstreamRequests.length, 0);

		const canary = await request(CONTEXT_A, tokenA, requestBody());
		assert.equal(canary.status, 200);
		assert.match(await canary.text(), /response\.completed/);
		assert.equal(customerSends, 0);
		assert.equal(upstreamRequests.length, 1);
		const [upstream] = upstreamRequests;
		assert.equal(upstream.url, "https://api.openai.com/v1/responses");
		assert.equal(upstream.headers.get("authorization"), `Bearer ${state.config.openAi.apiKey}`);
		assert.notEqual(upstream.headers.get("authorization"), `Bearer ${tokenA}`);
		assert.equal(upstream.body.model, "gpt-5.6-luna");
		assert.equal(upstream.body.reasoning.effort, "max");
		assert.equal(upstream.body.max_output_tokens, 32_768);
		assert.equal(upstream.body.stream, true);
		assert.equal(upstream.body.store, false);
		assert.equal(upstream.body.service_tier, "default");
		assert.notEqual(upstream.body.prompt_cache_key, "synthetic-session");
		assert.equal(upstream.body.prompt_cache_key.length, 43);

		const status = state.store.openAiStatus(state.config.openAi);
		assert.equal(status.settled, 1);
		assert.equal(status.uncertain, 0);
		assert.equal(status.chargedMicrodollars, 48);
	} finally {
		await new Promise((resolvePromise) => server.close(resolvePromise));
		closeFixture(state);
	}
});

test("one exact context can use Sol xhigh without changing its default Luna neighbor", async () => {
	const state = fixture({ contextModels: { [CONTEXT_B]: SOL_MODEL } });
	const upstreamRequests = [];
	const gateway = new HostOpenAi({
		config: state.config,
		store: state.store,
		fetchImpl: async (_input, init) => {
			const body = JSON.parse(String(init.body));
			upstreamRequests.push(body);
			return successfulResponse(body.model);
		},
	});
	try {
		await assert.rejects(
			gateway.complete(state.target, CONTEXT_B, requestBody({ model: LUNA_MODEL })),
			(error) => error?.code === "openai_model_denied",
		);
		await assert.rejects(
			gateway.complete(state.target, CONTEXT_B, requestBody({
				model: SOL_MODEL,
				reasoning: { effort: "max", summary: "auto" },
			})),
			(error) => error?.code === "openai_thinking_denied",
		);
		assert.equal(upstreamRequests.length, 0);

		const response = await gateway.complete(
			state.target,
			CONTEXT_B,
			requestBody({ model: SOL_MODEL }),
		);
		assert.match(await response.text(), /response\.completed/);
		assert.equal(upstreamRequests.length, 1);
		assert.equal(upstreamRequests[0].model, SOL_MODEL);
		assert.equal(upstreamRequests[0].reasoning.effort, "xhigh");
		assert.equal(upstreamRequests[0].max_output_tokens, 32_768);

		const luna = resolveContextRuntimeModel(
			state.config,
			state.store,
			undefined,
			state.target,
			CONTEXT_A,
		);
		assert.equal(luna.id, LUNA_MODEL);
		assert.equal(luna.thinking, "max");
		const status = state.store.openAiStatus(state.config.openAi);
		assert.equal(status.chargedMicrodollars, 838);
		assert.deepEqual(status.usageByModel.map((row) => ({
			model: row.model,
			settled: row.settled,
			chargedMicrodollars: row.chargedMicrodollars,
		})), [{ model: SOL_MODEL, settled: 1, chargedMicrodollars: 838 }]);
	} finally {
		closeFixture(state);
	}
});

test("OpenAI reservation cap and context/global concurrency fail closed before provider calls", async () => {
	const state = fixture({ monthlySpendCapCents: 100, maximumConcurrentGlobal: 1 });
	const controllers = [];
	let upstreamCalls = 0;
	const gateway = new HostOpenAi({
		config: state.config,
		store: state.store,
		fetchImpl: async () => {
			upstreamCalls += 1;
			return new Response(new ReadableStream({
				start(controller) { controllers.push(controller); },
			}), { status: 200, headers: { "content-type": "text/event-stream" } });
		},
	});
	try {
		const first = await gateway.complete(state.target, CONTEXT_A, requestBody());
		await assert.rejects(
			gateway.complete(state.target, CONTEXT_A, requestBody()),
			(error) => error?.code === "openai_context_concurrency_limited",
		);
		await assert.rejects(
			gateway.complete(state.target, CONTEXT_B, requestBody()),
			(error) => error?.code === "openai_global_concurrency_limited",
		);
		assert.equal(upstreamCalls, 1);
		await first.body.cancel("test complete");
		assert.equal(state.store.openAiStatus(state.config.openAi).uncertain, 1);
		await assert.rejects(
			gateway.complete(state.target, CONTEXT_B, requestBody()),
			(error) => error?.code === "openai_monthly_spend_cap_exhausted",
		);
		assert.equal(upstreamCalls, 1);
		assert.equal(state.store.openAiStatus(state.config.openAi).rejected, 3);
	} finally {
		for (const controller of controllers) {
			try { controller.close(); } catch { /* already cancelled */ }
		}
		closeFixture(state);
	}
});

test("OpenAI reservations survive restart and expired work keeps its worst-case charge", () => {
	const state = fixture({ monthlySpendCapCents: 100 });
	const reservedMicrodollars = worstCaseOpenAiReservationMicrodollars(LUNA_MODEL, 32_768);
	const firstAt = "2026-08-15T12:00:00.000Z";
	state.store.reserveOpenAiRequest({
		id: "00000000-0000-4000-8000-000000000001",
		targetId: state.target.id,
		contextId: CONTEXT_A,
		model: HOSTD_OPENAI_MODEL,
		monthStartedAt: "2026-08-01T00:00:00.000Z",
		observedAt: firstAt,
		expiresAt: "2026-08-15T12:00:01.000Z",
		reservedMicrodollars,
		monthlySpendCapCents: 100,
		maximumConcurrentPerContext: 1,
		maximumConcurrentGlobal: 2,
	});
	state.store.close();
	state.store = new HostStore(state.database);
	try {
		const second = state.store.reserveOpenAiRequest({
			id: "00000000-0000-4000-8000-000000000002",
			targetId: state.target.id,
			contextId: CONTEXT_B,
			model: HOSTD_OPENAI_MODEL,
			monthStartedAt: "2026-08-01T00:00:00.000Z",
			observedAt: "2026-08-15T12:00:02.000Z",
			expiresAt: "2026-08-15T12:00:03.000Z",
			reservedMicrodollars,
			monthlySpendCapCents: 100,
			maximumConcurrentPerContext: 1,
			maximumConcurrentGlobal: 2,
		});
		assert.equal(second.allowed, false);
		assert.equal(second.code, "openai_monthly_spend_cap_exhausted");
		const first = state.store.getOpenAiRequest("00000000-0000-4000-8000-000000000001");
		assert.equal(first.status, "uncertain");
		assert.equal(first.chargedMicrodollars, reservedMicrodollars);
	} finally {
		closeFixture(state);
	}
});

test("an ambiguous OpenAI failure is attempted once and permanently reserves worst-case spend", async () => {
	const state = fixture();
	let attempts = 0;
	const gateway = new HostOpenAi({
		config: state.config,
		store: state.store,
		fetchImpl: async () => {
			attempts += 1;
			throw new Error("synthetic connection loss");
		},
	});
	try {
		await assert.rejects(
			gateway.complete(state.target, CONTEXT_A, requestBody()),
			(error) => error?.status === 409 && error?.code === "openai_result_uncertain",
		);
		assert.equal(attempts, 1);
		const status = state.store.openAiStatus(state.config.openAi);
		assert.equal(status.uncertain, 1);
		assert.equal(
			status.chargedMicrodollars,
			worstCaseOpenAiReservationMicrodollars(LUNA_MODEL, state.config.openAi.maximumOutputTokens),
		);
	} finally {
		closeFixture(state);
	}
});
