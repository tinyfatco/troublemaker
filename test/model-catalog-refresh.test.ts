import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import {
	getLiveModelCatalogSnapshot,
	refreshLiveModelCatalog,
	startLiveModelCatalogRefresh,
} from "../src/model-catalog-refresh.js";
import { findModel, getCurrentModelSelection, listModels, resolveModel } from "../src/model-config.js";

const template = getModels("openai-codex")[0] as Model<Api>;
assert(template, "the bundled OpenAI Codex provider supplies a model template");

function model(id: string, extra: Record<string, unknown> = {}): Model<Api> {
	return {
		...template,
		provider: "openai-codex",
		id,
		name: id === "gpt-6-astra" ? "GPT-6 Astra" : id,
		baseUrl: "https://chatgpt.com/backend-api",
		...extra,
	} as Model<Api>;
}

class FakeRegistry {
	refreshCalls: ModelsRefreshOptions[] = [];
	available: Model<Api>[];
	authenticated = true;
	onRefresh?: (options: ModelsRefreshOptions) => Promise<ModelsRefreshResult>;

	constructor(available: Model<Api>[]) {
		this.available = available;
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		this.refreshCalls.push(options);
		if (this.onRefresh) return this.onRefresh(options);
		return { aborted: false, errors: new Map() };
	}

	getAvailable(): Model<Api>[] {
		return [...this.available];
	}

	hasConfiguredAuth(): boolean {
		return this.authenticated;
	}
}

const roots: string[] = [];
const inheritedProvider = process.env.MOM_MODEL_PROVIDER;
const inheritedModel = process.env.MOM_MODEL_ID;
delete process.env.MOM_MODEL_PROVIDER;
delete process.env.MOM_MODEL_ID;

function workspace(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `model-catalog-${name}-`));
	roots.push(root);
	return root;
}

try {
	const primary = workspace("primary");
	writeFileSync(join(primary, "settings.json"), JSON.stringify({
		defaultProvider: "openai-codex",
		defaultModel: "gpt-5.5",
	}));
	const beforeSelection = getCurrentModelSelection(primary);
	const registry = new FakeRegistry([model("gpt-5.5")]);
	registry.onRefresh = async () => {
		registry.available = [
			model("gpt-5.5"),
			model("gpt-6-astra", {
				apiKey: "SYNTHETIC_AUTH_MUST_NOT_BE_CACHED",
				headers: { Authorization: "Bearer SYNTHETIC_AUTH_MUST_NOT_BE_CACHED" },
			}),
		];
		return { aborted: false, errors: new Map() };
	};
	const handle = startLiveModelCatalogRefresh(primary, registry as any, { schedule: false });
	assert.equal(registry.refreshCalls.length, 0, "startup consumes cached Pi metadata without a network refresh");
	assert(!listModels(primary).some((entry) => entry.id === "gpt-6-astra"));

	const [firstRefresh, coalescedRefresh] = await Promise.all([
		handle.refreshNow(),
		refreshLiveModelCatalog(primary),
	]);
	assert.equal(firstRefresh, true);
	assert.equal(coalescedRefresh, true);
	assert.equal(registry.refreshCalls.length, 1, "concurrent refresh requests share one provider operation");
	assert.equal(registry.refreshCalls[0]?.allowNetwork, true);
	assert.deepEqual(registry.refreshCalls[0]?.providers, ["openai-codex"], "network refresh is provider-scoped");
	assert.equal(registry.refreshCalls[0]?.force, undefined, "Pi's four-hour catalog freshness cache remains authoritative");
	assert(listModels(primary).some((entry) => entry.provider === "openai-codex" && entry.id === "gpt-6-astra"), "synchronous model lists see refreshed Astra metadata");
	assert.equal(findModel("gpt-6-astra", primary)?.provider, "openai-codex", "explicit model resolution sees refreshed Astra metadata");
	assert.deepEqual(getCurrentModelSelection(primary), beforeSelection, "catalog discovery never changes the selected model");
	writeFileSync(join(primary, "settings.json"), JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-6-astra" }));
	assert.equal(resolveModel(primary).id, "gpt-6-astra", "an explicit setting resolves the refreshed model for the next turn");
	writeFileSync(join(primary, "settings.json"), JSON.stringify({ defaultProvider: beforeSelection.provider, defaultModel: beforeSelection.id }));
	const cachedAstra = getLiveModelCatalogSnapshot(primary).find((entry) => entry.id === "gpt-6-astra") as Record<string, unknown> | undefined;
	assert(cachedAstra, "Astra is present in the workspace cache");
	assert.equal(cachedAstra.apiKey, undefined, "unknown auth-shaped model fields are not cached");
	assert.equal(cachedAstra.headers, undefined, "provider headers are not copied into discovery cache");
	assert(!JSON.stringify(cachedAstra).includes("SYNTHETIC_AUTH_MUST_NOT_BE_CACHED"));
	const otherWorkspace = workspace("isolated");
	assert(!listModels(otherWorkspace).some((entry) => entry.id === "gpt-6-astra"), "live catalog metadata cannot cross workspace identity");
	handle.stop();

	const offlineWorkspace = workspace("offline");
	const offlineRegistry = new FakeRegistry([model("gpt-6-astra")]);
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	const offline = startLiveModelCatalogRefresh(offlineWorkspace, offlineRegistry as any, { schedule: false });
	if (previousOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = previousOffline;
	assert(listModels(offlineWorkspace).some((entry) => entry.id === "gpt-6-astra"), "offline residents can use Pi's already-restored cache");
	assert.equal(await offline.refreshNow(), false);
	assert.equal(offlineRegistry.refreshCalls.length, 0, "PI_OFFLINE never starts network catalog work");
	offline.stop();

	const unauthenticatedWorkspace = workspace("unauthenticated");
	const unauthenticatedRegistry = new FakeRegistry([model("gpt-6-astra")]);
	unauthenticatedRegistry.authenticated = false;
	const unauthenticated = startLiveModelCatalogRefresh(unauthenticatedWorkspace, unauthenticatedRegistry as any, { schedule: false });
	assert(!listModels(unauthenticatedWorkspace).some((entry) => entry.id === "gpt-6-astra"), "unauthenticated dynamic models fail closed out of discovery");
	unauthenticated.stop();

	const malformedWorkspace = workspace("malformed");
	const malformedRegistry = new FakeRegistry([
		model("gpt-6-astra\ncontrol"),
		{ ...model("gpt-6-astra"), baseUrl: "http://chatgpt.com/backend-api" },
		{ ...model("gpt-6-astra"), baseUrl: "https://models.example.com/backend-api" },
		{ ...model("gpt-6-astra"), baseUrl: `https://user:pass${String.fromCharCode(64)}chatgpt.com/backend-api` },
		{ ...model("gpt-6-astra"), baseUrl: "https://chatgpt.com/backend-api/v1" },
		{ ...model("gpt-6-astra"), baseUrl: "https://chatgpt.com/backend-api?route=other" },
		{ ...model("gpt-6-astra"), baseUrl: "https://chatgpt.com/backend-api#other" },
		{ ...model("gpt-6-astra"), api: "openai-responses" },
		{ ...model("gpt-6-astra"), provider: "example-provider" },
	]);
	const malformed = startLiveModelCatalogRefresh(malformedWorkspace, malformedRegistry as any, { schedule: false });
	assert.equal(getLiveModelCatalogSnapshot(malformedWorkspace).length, 0, "malformed IDs and wrong scheme, host, userinfo, path, query, hash, API, or provider are rejected");
	malformed.stop();

	const normalizedWorkspace = workspace("normalized");
	const normalizedRegistry = new FakeRegistry([{ ...model("gpt-6-astra"), baseUrl: "https://chatgpt.com/backend-api/" }]);
	const normalized = startLiveModelCatalogRefresh(normalizedWorkspace, normalizedRegistry as any, { schedule: false });
	assert.equal(getLiveModelCatalogSnapshot(normalizedWorkspace)[0]?.baseUrl, "https://chatgpt.com/backend-api", "trusted trailing slash normalizes to the exact Codex base URL");
	normalized.stop();

	const failureWorkspace = workspace("failure");
	const warnings: string[] = [];
	const failureRegistry = new FakeRegistry([model("gpt-6-astra")]);
	failureRegistry.onRefresh = async () => { throw new Error("synthetic offline failure"); };
	const failing = startLiveModelCatalogRefresh(failureWorkspace, failureRegistry as any, {
		schedule: false,
		warn: (message) => warnings.push(message),
	});
	assert.equal(await failing.refreshNow(), false);
	assert(listModels(failureWorkspace).some((entry) => entry.id === "gpt-6-astra"), "network failure preserves the last authenticated cached snapshot");
	assert.deepEqual(warnings, ["Live model catalog refresh failed; keeping the last cached snapshot"]);
	failing.stop();

	const timeoutWorkspace = workspace("timeout");
	const timeoutRegistry = new FakeRegistry([model("gpt-5.5")]);
	timeoutRegistry.onRefresh = (options) => new Promise((_resolve, reject) => {
		options.signal?.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true });
	});
	const timed = startLiveModelCatalogRefresh(timeoutWorkspace, timeoutRegistry as any, {
		schedule: false,
		timeoutMs: 10,
	});
	const keepTestAlive = setTimeout(() => {}, 100);
	try {
		assert.equal(await timed.refreshNow(), false, "timed-out refresh fails closed");
	} finally {
		clearTimeout(keepTestAlive);
	}
	assert.equal(timeoutRegistry.refreshCalls.length, 1);
	assert.deepEqual(getCurrentModelSelection(primary), beforeSelection, "timeout cannot switch another resident's model");
	timed.stop();

	console.log("model catalog live refresh ok");
} finally {
	if (inheritedProvider === undefined) delete process.env.MOM_MODEL_PROVIDER;
	else process.env.MOM_MODEL_PROVIDER = inheritedProvider;
	if (inheritedModel === undefined) delete process.env.MOM_MODEL_ID;
	else process.env.MOM_MODEL_ID = inheritedModel;
	assert.equal(process.env.MOM_MODEL_PROVIDER, inheritedProvider, "catalog tests restore the ordinary host provider selection");
	assert.equal(process.env.MOM_MODEL_ID, inheritedModel, "catalog tests restore the ordinary host model selection");
	for (const root of roots) rmSync(root, { recursive: true, force: true });
}
