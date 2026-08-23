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
} from "../src/runtime-model.mjs";
import { contextCapability } from "../src/security.mjs";
import { createHostServer } from "../src/server.mjs";
import { HostStore } from "../src/store.mjs";

const CONTEXT_A = "front-desk:relationship-a";
const CONTEXT_B = "front-desk:relationship-b";

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
	return {
		model: HOSTD_OPENAI_MODEL,
		input: [{ role: "user", content: [{ type: "input_text", text: "Synthetic canary" }] }],
		stream: true,
		store: false,
		reasoning: { effort: "xhigh", summary: "auto" },
		prompt_cache_key: "synthetic-session",
		include: ["reasoning.encrypted_content"],
		tools: [{ type: "function", name: "synthetic_check", parameters: { type: "object" } }],
		...overrides,
	};
}

function successfulResponse() {
	return new Response(
		'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
		+ 'data: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":'
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
	assert.equal(worstCaseOpenAiReservationMicrodollars(32_768), 11_483_040);
	assert.equal(worstCaseOpenAiReservationMicrodollars(128_000), 14_340_000);
	assert.equal(openAiUsageMicrodollars({
		inputTokens: 100,
		cachedInputTokens: 20,
		cacheWriteTokens: 10,
		outputTokens: 25,
	}), 838);
	assert.equal(openAiUsageMicrodollars({
		inputTokens: 300_000,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 1000,
	}), 2_430_000);
});

test("the hard $25 monthly cap admits only two worst-case Sol reservations", () => {
	const state = fixture();
	const reservedMicrodollars = worstCaseOpenAiReservationMicrodollars(32_768);
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
		maximumConcurrentPerContext: 3,
		maximumConcurrentGlobal: 3,
	});
	try {
		assert.equal(reserve("00000000-0000-4000-8000-000000000011").allowed, true);
		assert.equal(reserve("00000000-0000-4000-8000-000000000012").allowed, true);
		const third = reserve("00000000-0000-4000-8000-000000000013");
		assert.equal(third.allowed, false);
		assert.equal(third.code, "openai_monthly_spend_cap_exhausted");
		assert.equal(third.committedMicrodollars, 22_966_080);
		assert.equal(third.capMicrodollars, 25_000_000);
	} finally {
		closeFixture(state);
	}
});

test("OpenAI runtime selection overrides dormant Workers AI with context-only proxy authority", () => {
	const state = fixture();
	try {
		const selected = resolveContextRuntimeModel(
			state.config,
			state.store,
			Buffer.alloc(32, 7),
			state.target,
			CONTEXT_A,
		);
		assert.deepEqual(selected, {
			provider: "openai",
			id: "gpt-5.6-sol",
			thinking: "xhigh",
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
			model: "gpt-5.6-sol",
			thinking: "xhigh",
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

test("synthetic no-customer-send canary enforces isolation, exact model, xhigh thinking, and output bounds", async () => {
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
			requestBody({ model: "gpt-5.6-luna" }),
			requestBody({ reasoning: { effort: "high" } }),
			requestBody({ reasoning: { effort: "max" } }),
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
		assert.equal(upstream.body.model, "gpt-5.6-sol");
		assert.equal(upstream.body.reasoning.effort, "xhigh");
		assert.equal(upstream.body.max_output_tokens, 32_768);
		assert.equal(upstream.body.stream, true);
		assert.equal(upstream.body.store, false);
		assert.equal(upstream.body.service_tier, "default");
		assert.notEqual(upstream.body.prompt_cache_key, "synthetic-session");
		assert.equal(upstream.body.prompt_cache_key.length, 43);

		const status = state.store.openAiStatus(state.config.openAi);
		assert.equal(status.settled, 1);
		assert.equal(status.uncertain, 0);
		assert.equal(status.chargedMicrodollars, 838);
	} finally {
		await new Promise((resolvePromise) => server.close(resolvePromise));
		closeFixture(state);
	}
});

test("OpenAI reservation cap and context/global concurrency fail closed before provider calls", async () => {
	const state = fixture({ monthlySpendCapCents: 1500, maximumConcurrentGlobal: 1 });
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
	const state = fixture({ monthlySpendCapCents: 1500 });
	const reservedMicrodollars = worstCaseOpenAiReservationMicrodollars(32_768);
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
		monthlySpendCapCents: 1500,
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
			monthlySpendCapCents: 1500,
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
			worstCaseOpenAiReservationMicrodollars(state.config.openAi.maximumOutputTokens),
		);
	} finally {
		closeFixture(state);
	}
});
