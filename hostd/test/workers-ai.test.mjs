import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextRouter } from "../src/router.mjs";
import { contextCapability } from "../src/security.mjs";
import { createHostServer } from "../src/server.mjs";
import { HostStore } from "../src/store.mjs";
import {
	HostWorkersAi,
	resolveContextRuntimeModel,
	runtimeModelEnvironment,
	runtimeModelVersionSuffix,
} from "../src/workers-ai.mjs";

const MODEL = {
	provider: "cloudflare-workers-ai",
	id: "@cf/zai-org/glm-5.2",
};

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-workers-ai-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const routingKey = Buffer.alloc(32, 7);
	const target = {
		id: "front-desk",
		driver: "oci",
		inboundToken: "synthetic-inbound-secret",
		outboundToken: "synthetic-outbound-secret",
		hostGateway: "host.containers.internal",
	};
	const config = {
		server: { port: 3099 },
		scheduler: { maxConcurrent: 1 },
		routing: {
			actorTarget: target.id,
			knownPrincipals: [],
			knownPhonePrincipals: [
				{ phone: "+15555550123", name: "Owner", model: MODEL },
				{ phone: "+15555550124", name: "Other person" },
			],
		},
		workersAi: {
			accountId: "0123456789abcdef0123456789abcdef",
			apiToken: "host-only-cloudflare-token",
			apiBaseUrl: "https://api.cloudflare.test/client/v4",
			allowedModels: [MODEL.id],
			gatewayId: undefined,
			analyticsToken: undefined,
			analyticsPollSeconds: 900,
			analyticsLookbackSeconds: 21_600,
			requestTimeoutMs: 10_000,
			maximumRequestBytes: 64 * 1024,
			limits: {
				windowSeconds: 900,
				maximumRequestsPerContext: 12,
				maximumTokensPerContext: 1_000_000,
				maximumRequestsGlobal: 60,
				maximumTokensGlobal: 5_000_000,
				maximumConcurrentPerContext: 1,
				maximumConcurrentGlobal: 4,
			},
		},
		targetsById: new Map([[target.id, target]]),
	};
	const router = new ContextRouter(config, store, routingKey);
	const owner = router.resolvePhone({
		providerThreadId: "owner-phone-thread",
		contactAddress: "+15555550123",
		label: "Phone ending 0123",
	});
	const other = router.resolvePhone({
		providerThreadId: "other-phone-thread",
		contactAddress: "+15555550124",
		label: "Phone ending 0124",
	});
	return { directory, store, routingKey, target, config, owner, other };
}

test("Workers AI model selection and credentials are exact-principal scoped", () => {
	const state = fixture();
	try {
		const selected = resolveContextRuntimeModel(
			state.config,
			state.store,
			state.routingKey,
			state.target,
			state.owner.contextId,
		);
		assert.deepEqual(selected, MODEL);
		assert.equal(resolveContextRuntimeModel(
			state.config,
			state.store,
			state.routingKey,
			state.target,
			state.other.contextId,
		), undefined);

		const env = runtimeModelEnvironment(
			state.config,
			state.target,
			state.owner.contextId,
			selected,
		);
		assert.equal(env.MOM_MODEL_PROVIDER, MODEL.provider);
		assert.equal(env.MOM_MODEL_ID, MODEL.id);
		assert.equal(
			env.CLOUDFLARE_WORKERS_AI_BASE_URL,
			`http://host.containers.internal:3099/v1/workers-ai/${encodeURIComponent(state.owner.contextId)}`,
		);
		assert.equal(
			env.CLOUDFLARE_API_KEY,
			contextCapability(state.target.outboundToken, "workers-ai", state.owner.contextId),
		);
		assert.notEqual(env.CLOUDFLARE_API_KEY, state.config.workersAi.apiToken);
		assert.match(runtimeModelVersionSuffix(selected), /^:model-[0-9a-f]{12}$/);

		state.store.bindRoute({
			source: "gmail",
			providerThreadId: "mixed-source-thread",
			principalHash: state.owner.principalHash,
			projectSlug: state.owner.projectSlug,
			targetId: state.owner.targetId,
			contextId: state.owner.contextId,
		});
		assert.equal(resolveContextRuntimeModel(
			state.config,
			state.store,
			state.routingKey,
			state.target,
			state.owner.contextId,
		), undefined);
	} finally {
		state.store.close();
		rmSync(state.directory, { recursive: true, force: true });
	}
});

test("Hostd proxies only the selected context and strips caller-selected model authority", async () => {
	const state = fixture();
	state.config.workersAi.limits.maximumRequestsPerContext = 1;
	const upstreamRequests = [];
	const workersAiGateway = new HostWorkersAi({
		config: state.config,
		store: state.store,
		routingKey: state.routingKey,
		fetchImpl: async (input, init) => {
			upstreamRequests.push({
				url: String(input),
				headers: new Headers(init.headers),
				body: JSON.parse(String(init.body)),
			});
			return new Response(
				'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
				+ 'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":8,"total_tokens":50,"prompt_tokens_details":{"cached_tokens":20}}}\n\n'
				+ 'data: [DONE]\n\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const server = createHostServer({
		config: state.config,
		store: state.store,
		daemon: { polling: false },
		workersAiGateway,
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const endpoint = (contextId) => (
		`http://127.0.0.1:${address.port}/v1/workers-ai/${encodeURIComponent(contextId)}/chat/completions`
	);
	const request = (contextId, token, model = MODEL.id) => fetch(endpoint(contextId), {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], stream: true }),
	});

	try {
		const ownerToken = contextCapability(
			state.target.outboundToken,
			"workers-ai",
			state.owner.contextId,
		);
		const unauthorized = await request(state.owner.contextId, "wrong-token");
		assert.equal(unauthorized.status, 401);

		const otherToken = contextCapability(
			state.target.outboundToken,
			"workers-ai",
			state.other.contextId,
		);
		const deniedContext = await request(state.other.contextId, otherToken);
		assert.equal(deniedContext.status, 403);
		assert.deepEqual(await deniedContext.json(), { error: "workers_ai_context_denied" });

		const deniedModel = await request(state.owner.contextId, ownerToken, "@cf/example/other");
		assert.equal(deniedModel.status, 403);
		assert.deepEqual(await deniedModel.json(), { error: "workers_ai_model_denied" });

		const response = await request(state.owner.contextId, ownerToken);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		assert.match(await response.text(), /"content":"hello"/);
		assert.equal(upstreamRequests.length, 1);
		assert.equal(
			upstreamRequests[0].url,
			`https://api.cloudflare.test/client/v4/accounts/${state.config.workersAi.accountId}/ai/run/${MODEL.id}`,
		);
		assert.equal(
			upstreamRequests[0].headers.get("authorization"),
			"Bearer host-only-cloudflare-token",
		);
		assert.equal(upstreamRequests[0].headers.get("cf-aig-collect-log-payload"), "false");
		assert.deepEqual(
			Object.keys(JSON.parse(upstreamRequests[0].headers.get("cf-aig-metadata"))).sort(),
			["request_id", "service"],
		);
		assert.equal("model" in upstreamRequests[0].body, false);
		assert.deepEqual(upstreamRequests[0].body.messages, [{ role: "user", content: "hello" }]);

		const limited = await request(state.owner.contextId, ownerToken);
		assert.equal(limited.status, 429);
		assert.deepEqual(await limited.json(), { error: "workers_ai_context_request_limited" });
		assert.match(limited.headers.get("retry-after"), /^\d+$/);
		const repeatedLimited = await request(state.owner.contextId, ownerToken);
		assert.equal(repeatedLimited.status, 429);
		await repeatedLimited.arrayBuffer();
		assert.equal(upstreamRequests.length, 1);

		const usage = state.store.workersAiStatus(state.config.workersAi);
		assert.equal(usage.endpointWindows[0].requests, 1);
		assert.equal(usage.endpointWindows[0].rejected, 2);
		assert.equal(usage.endpointWindows[0].inputTokens, 42);
		assert.equal(usage.endpointWindows[0].cachedInputTokens, 20);
		assert.equal(usage.endpointWindows[0].outputTokens, 8);
		assert.equal(usage.endpointWindows[0].totalTokens, 50);
		assert.equal(usage.currentContexts[0].contextId, state.owner.contextId);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => (
			error ? reject(error) : resolvePromise()
		)));
		state.store.close();
		rmSync(state.directory, { recursive: true, force: true });
	}
});

test("Workers AI token and concurrency limits fail closed before another provider call", async () => {
	const state = fixture();
	let upstreamCalls = 0;
	state.config.workersAi.limits.maximumTokensPerContext = 100;
	const gateway = new HostWorkersAi({
		config: state.config,
		store: state.store,
		routingKey: state.routingKey,
		fetchImpl: async () => {
			upstreamCalls++;
			return new Response(
				'data: {"choices":[],"usage":{"prompt_tokens":90,"completion_tokens":20,"total_tokens":110}}\n\n'
				+ 'data: [DONE]\n\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const body = { model: MODEL.id, messages: [{ role: "user", content: "hello" }], stream: true };
	try {
		const first = await gateway.complete(state.target, state.owner.contextId, body);
		await first.text();
		await assert.rejects(
			gateway.complete(state.target, state.owner.contextId, body),
			(error) => error?.status === 429 && error?.code === "workers_ai_context_token_limited",
		);
		assert.equal(upstreamCalls, 1);

		state.config.workersAi.limits.maximumTokensPerContext = 1_000_000;
		const concurrentGateway = new HostWorkersAi({
			config: state.config,
			store: state.store,
			routingKey: state.routingKey,
			fetchImpl: async () => new Response(new ReadableStream({
				start() {},
			})),
		});
		const inFlight = await concurrentGateway.complete(state.target, state.owner.contextId, body);
		await assert.rejects(
			concurrentGateway.complete(state.target, state.owner.contextId, body),
			(error) => error?.status === 429 && error?.code === "workers_ai_context_concurrency_limited",
		);
		await inFlight.body.cancel();
		const usage = state.store.workersAiStatus(state.config.workersAi);
		assert(usage.endpointWindows[0].aborted >= 1);
	} finally {
		state.store.close();
		rmSync(state.directory, { recursive: true, force: true });
	}
});

test("Workers AI polls authoritative Cloudflare neuron usage into fifteen-minute buckets", async () => {
	const state = fixture();
	state.config.workersAi.analyticsToken = "host-only-analytics-token";
	const observedRequests = [];
	const now = Date.parse("2026-08-18T08:31:00.000Z");
	const gateway = new HostWorkersAi({
		config: state.config,
		store: state.store,
		routingKey: state.routingKey,
		nowImpl: () => now,
		analyticsUrl: "https://analytics.example/graphql",
		fetchImpl: async (input, init) => {
			observedRequests.push({ input: String(input), init });
			return new Response(JSON.stringify({
				data: {
					viewer: {
						accounts: [{
							aiInferenceAdaptiveGroups: [{
								count: 2,
								dimensions: {
									datetimeFifteenMinutes: "2026-08-18T08:15:00Z",
									modelId: MODEL.id,
									requestSource: "rest api",
									errorCode: 0,
								},
								sum: {
									totalInputTokens: 254_403,
									totalOutputTokens: 61,
									totalNeurons: 19_230.366553097963,
								},
							}],
						}],
					},
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		},
	});
	try {
		const rows = await gateway.pollProviderUsage();
		assert.equal(rows.length, 1);
		assert.equal(observedRequests[0].input, "https://analytics.example/graphql");
		assert.equal(
			new Headers(observedRequests[0].init.headers).get("authorization"),
			"Bearer host-only-analytics-token",
		);
		const query = JSON.parse(observedRequests[0].init.body);
		assert.equal(query.variables.accountTag, state.config.workersAi.accountId);
		assert.deepEqual(query.variables.models, [MODEL.id]);
		assert.equal(query.variables.start, "2026-08-18T02:30:00.000Z");

		const status = state.store.workersAiStatus(state.config.workersAi);
		assert.equal(status.providerWindows[0].requests, 2);
		assert.equal(status.providerWindows[0].inputTokens, 254_403);
		assert.equal(status.providerWindows[0].outputTokens, 61);
		assert.equal(status.providerWindows[0].neurons, 19_230.366553097963);
		assert(!JSON.stringify(status).includes("host-only-analytics-token"));
	} finally {
		state.store.close();
		rmSync(state.directory, { recursive: true, force: true });
	}
});
