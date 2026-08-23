/**
 * Model resolution and runtime switching.
 *
 * Priority: env vars > settings.json > defaults.
 *
 * Models are resolved through ModelRegistry so built-in pi-ai providers plus
 * any workspace models.json entries are available to /model and runtime resolution.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	getModels as getBuiltinModels,
	getProviders as getBuiltinProviders,
} from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
	getClaudeCliModel,
	isClaudeCliAuthenticated,
	isClaudeCliProvider,
	listClaudeCliModels,
} from "./claude-cli.js";
import { DEFAULT_FIREWORKS_MODEL_ID, getFireworksModel, GLM_5P2_MODEL_ID, listBuiltinFireworksModels } from "./fireworks-models.js";
import * as log from "./log.js";

const DEFAULT_PROVIDER = "fireworks";
const DEFAULT_MODEL_ID = DEFAULT_FIREWORKS_MODEL_ID;
export const HOSTD_OPENAI_PROVIDER = "openai";
export const HOSTD_OPENAI_MODEL_ID = "gpt-5.6-sol";

export function isMigratedHostdOpenAi(): boolean {
	return process.env.TROUBLEMAKER_HOSTD_OPENAI_MIGRATED === "1";
}

export function getEnvironmentModelOverride(): { provider: string; id: string } | undefined {
	const provider = process.env.MOM_MODEL_PROVIDER?.trim();
	const id = process.env.MOM_MODEL_ID?.trim();
	if (!provider && !id) return undefined;
	if (!provider || !id) {
		throw new Error("MOM_MODEL_PROVIDER and MOM_MODEL_ID must be configured together");
	}
	return { provider, id };
}

/**
 * Friendly aliases for Anthropic models.
 */
const ANTHROPIC_ALIAS_TO_MODEL_ID: Record<string, string> = {
	opus: "claude-opus-4-6",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5-20251001",
	"opus-4.6": "claude-opus-4-6",
	"sonnet-4.6": "claude-sonnet-4-6",
	"haiku-4.5": "claude-haiku-4-5-20251001",
};

/**
 * Friendly aliases for OpenAI models.
 */
const OPENAI_ALIAS_TO_MODEL_ID: Record<string, string> = {
	gpt5: "gpt-5.5",
	gptfive: "gpt-5.5",
	"gpt-5": "gpt-5.5",
	"gpt-5.5": "gpt-5.5",
	codex: "codex-5.3",
	"codex-5.3": "codex-5.3",
};

/**
 * Anthropic models to show in /model list (filter out the long tail of old models).
 */
const ANTHROPIC_LISTED_MODELS = new Set([
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5-20251001",
]);

const FIREWORKS_ALIAS_TO_MODEL_ID: Record<string, string> = {
	minimax: "accounts/fireworks/models/minimax-m2p7",
	deepseek: "accounts/fireworks/models/deepseek-v4-pro",
	kimi: "accounts/fireworks/models/kimi-k2p6",
	glm: GLM_5P2_MODEL_ID,
	glm5: GLM_5P2_MODEL_ID,
	"glm-5p2": GLM_5P2_MODEL_ID,
	"glm-5.2": GLM_5P2_MODEL_ID,
	"glm-52": GLM_5P2_MODEL_ID,
	"glm-5p1": "accounts/fireworks/models/glm-5p1",
	"glm-5.1": "accounts/fireworks/models/glm-5p1",
	qwen: "accounts/fireworks/models/qwen3p6-plus",
	"qwen3p6": "accounts/fireworks/models/qwen3p6-plus",
	"qwen3.6": "accounts/fireworks/models/qwen3p6-plus",
	"glm-fast": "accounts/fireworks/routers/glm-5p1-fast",
	"kimi-turbo": "accounts/fireworks/routers/kimi-k2p6-turbo",
};

const CURATED_MODEL_OPTIONS: Array<{ provider: string; id: string; name: string; api: string }> = [
	{
		provider: "openai-codex",
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-codex-responses",
	},
	{
		provider: "openai-codex",
		id: "codex-5.3",
		name: "Codex 5.3",
		api: "openai-codex-responses",
	},
	{
		provider: "openai",
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-responses",
	},
	{
		provider: "fireworks",
		id: "accounts/fireworks/models/minimax-m2p7",
		name: "MiniMax-M2.7",
		api: "anthropic-messages",
	},
	{
		provider: "fireworks",
		id: "accounts/fireworks/models/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "anthropic-messages",
	},
	{
		provider: "fireworks",
		id: "accounts/fireworks/models/kimi-k2p6",
		name: "Kimi K2.6",
		api: "anthropic-messages",
	},
	{
		provider: "fireworks",
		id: GLM_5P2_MODEL_ID,
		name: "GLM-5.2",
		api: "anthropic-messages",
	},
	{
		provider: "fireworks",
		id: "accounts/fireworks/models/glm-5p1",
		name: "GLM-5.1",
		api: "anthropic-messages",
	},
	{
		provider: "fireworks",
		id: "accounts/fireworks/models/qwen3p6-plus",
		name: "Qwen3.6 Plus",
		api: "anthropic-messages",
	},
	{
		provider: "anthropic",
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		api: "anthropic-messages",
	},
	{
		provider: "anthropic",
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
	},
	{
		provider: "anthropic",
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages",
	},
];

const MODEL_PROVIDER_RANK: Record<string, number> = {
	"openai-codex": 0,
	fireworks: 1,
	"claude-cli": 2,
	anthropic: 3,
	openai: 4,
};

function getRegistryModels(_workingDir?: string, modelRegistry?: ModelRegistry): Model<Api>[] {
	const models = modelRegistry
		? modelRegistry.getAll()
		: getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider)) as Model<Api>[];
	return mergeBuiltinModels(models);
}

function mergeBuiltinModels(models: Model<Api>[]): Model<Api>[] {
	const byKey = new Map<string, Model<Api>>();
	for (const model of models) byKey.set(modelKey(model.provider, model.id), model);
	for (const model of listBuiltinFireworksModels()) byKey.set(modelKey(model.provider, model.id), model);
	return Array.from(byKey.values());
}

function findExactModel(models: Model<Api>[], provider: string, modelId: string): Model<Api> | undefined {
	const normalizedProvider = provider.toLowerCase().trim();
	const normalizedModelId = modelId.toLowerCase().trim();
	return models.find(
		(model) =>
			model.provider.toLowerCase() === normalizedProvider &&
			model.id.toLowerCase() === normalizedModelId,
	);
}

function resolveFireworksAliasModel(
	models: Model<Api>[],
	alias: string,
	providerHint?: string,
): Model<Api> | undefined {
	const normalizedAlias = alias.toLowerCase().trim();
	const modelId = FIREWORKS_ALIAS_TO_MODEL_ID[normalizedAlias];
	if (!modelId) return undefined;
	if (providerHint && providerHint.toLowerCase().trim() !== "fireworks") return undefined;
	return findExactModel(models, "fireworks", modelId);
}

/**
 * Resolve the model from env vars or settings.json, falling back to defaults.
 *
 * Priority:
 * 1. MOM_MODEL_PROVIDER + MOM_MODEL_ID env vars (set by platform)
 * 2. settings.json defaultProvider + defaultModel (set by /model command or agent)
 * 3. fireworks / accounts/fireworks/models/glm-5p2
 */
export function resolveModel(workingDir?: string, modelRegistry?: ModelRegistry): Model<Api> {
	const { provider, id: modelId } = getCurrentModelSelection(workingDir);
	if (isClaudeCliProvider(provider)) {
		const cliModel = getClaudeCliModel(modelId);
		if (!cliModel) {
			throw new Error(`Unsupported Claude CLI model: ${modelId}. Choose haiku, sonnet, opus, or fable.`);
		}
		log.logInfo(`Model: ${cliModel.provider}/${cliModel.id} (api: ${cliModel.api})`);
		return cliModel;
	}

	const models = getRegistryModels(workingDir, modelRegistry);

	let model = findExactModel(models, provider, modelId);
	if (!model) {
		model = resolveFireworksAliasModel(models, modelId, provider);
	}

	if (!model) {
		if (isMigratedHostdOpenAi()) {
			throw new Error(`Required migrated Hostd model not found: ${provider}/${modelId}`);
		}
		log.logWarning(
			`Model not found: ${provider}/${modelId}`,
			`Falling back to ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`,
		);

		const fallback =
			findExactModel(models, DEFAULT_PROVIDER, DEFAULT_MODEL_ID) ||
			getFireworksModel(DEFAULT_MODEL_ID);
		if (!fallback) {
			throw new Error(`Default model ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID} not found`);
		}
		return applyBaseUrlOverride(fallback, fallback.provider);
	}

	log.logInfo(`Model: ${model.provider}/${model.id} (api: ${model.api})`);
	return applyMigratedHostdOutputBound(applyBaseUrlOverride(model, model.provider));
}

export function resolveModelWithAuth(workingDir?: string, modelRegistry?: ModelRegistry): Model<Api> {
	const model = resolveModel(workingDir, modelRegistry);
	// Claude CLI owns its login state. Invocation reports an actionable CLI
	// auth error rather than silently falling back to an unrelated API model.
	if (isClaudeCliProvider(model.provider)) return model;
	if (isMigratedHostdOpenAi()) {
		if (!process.env.OPENAI_API_KEY?.trim()) {
			throw new ModelCredentialUnavailableError(HOSTD_OPENAI_PROVIDER);
		}
		return model;
	}
	if (!modelRegistry || modelRegistry.hasConfiguredAuth(model)) return model;

	log.logWarning(
		`Model auth not configured: ${model.provider}/${model.id}`,
		`Falling back to ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`,
	);

	const models = getRegistryModels(workingDir, modelRegistry);
	const fallback =
		findExactModel(models, DEFAULT_PROVIDER, DEFAULT_MODEL_ID) ||
		getFireworksModel(DEFAULT_MODEL_ID);
	if (!fallback) {
		throw new Error(`Default model ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID} not found`);
	}
	if (!modelRegistry.hasConfiguredAuth(fallback)) {
		log.logWarning(
			`Fallback model auth not configured: ${fallback.provider}/${fallback.id}`,
			"Model calls will fail until Fireworks auth is available.",
		);
	}
	return applyBaseUrlOverride(fallback, fallback.provider);
}

export function getCurrentModelSelection(workingDir?: string): { provider: string; id: string } {
	const environmentOverride = getEnvironmentModelOverride();
	let provider = environmentOverride?.provider;
	let modelId = environmentOverride?.id;

	if (isMigratedHostdOpenAi()) {
		if (provider !== HOSTD_OPENAI_PROVIDER || modelId !== HOSTD_OPENAI_MODEL_ID) {
			throw new Error(
				`Migrated Hostd contexts require ${HOSTD_OPENAI_PROVIDER}/${HOSTD_OPENAI_MODEL_ID}`,
			);
		}
		if (!process.env.OPENAI_BASE_URL?.trim()) {
			throw new Error("Migrated Hostd contexts require an OpenAI proxy base URL");
		}
	}

	if ((!provider || !modelId) && workingDir) {
		const settings = readSettings(workingDir);
		if (!provider && settings.defaultProvider) provider = settings.defaultProvider;
		if (!modelId && settings.defaultModel) modelId = settings.defaultModel;
	}

	return {
		provider: provider || DEFAULT_PROVIDER,
		id: modelId || DEFAULT_MODEL_ID,
	};
}

/**
 * Find a model by fuzzy matching against provider/id.
 * Accepts formats like "gpt-5.5", "anthropic/claude-sonnet-4-5", "minimax", etc.
 */
export function findModel(
	query: string,
	workingDir?: string,
	modelRegistry?: ModelRegistry,
): Model<Api> | undefined {
	const q = query.toLowerCase().trim();
	if (!q) return undefined;

	const allModels = getRegistryModels(workingDir, modelRegistry);
	if (isClaudeCliAuthenticated()) allModels.push(...listClaudeCliModels());

	// Friendly aliases first (e.g. /model minimax, /model opus, /model gpt5)
	const fwAlias = resolveFireworksAliasModel(allModels, q);
	if (fwAlias) return fwAlias;

	// Anthropic aliases
	const anthropicModelId = ANTHROPIC_ALIAS_TO_MODEL_ID[q];
	if (anthropicModelId) {
		const m = findExactModel(allModels, "anthropic", anthropicModelId);
		if (m) return m;
	}

	// OpenAI aliases — prefer openai-codex provider (subscription auth)
	const openaiModelId = OPENAI_ALIAS_TO_MODEL_ID[q];
	if (openaiModelId) {
		const m = findExactModel(allModels, "openai-codex", openaiModelId) ||
			findExactModel(allModels, "openai", openaiModelId);
		if (m) return m;
	}

	// Provider/model queries (supports nested IDs like openrouter/minimax/minimax-m2.1)
	if (q.includes("/")) {
		const [provider, ...rest] = q.split("/");
		const modelQuery = rest.join("/").trim();
		if (provider && modelQuery) {
			const exact = findExactModel(allModels, provider, modelQuery);
			if (exact) return exact;

			const providerAlias = resolveFireworksAliasModel(allModels, modelQuery, provider);
			if (providerAlias) return providerAlias;

			const providerIdMatches = allModels.filter(
				(m) =>
					m.provider.toLowerCase() === provider && m.id.toLowerCase().includes(modelQuery),
			);
			if (providerIdMatches.length === 1) return providerIdMatches[0];

			const providerNameMatches = allModels.filter(
				(m) =>
					m.provider.toLowerCase() === provider && m.name.toLowerCase().includes(modelQuery),
			);
			if (providerNameMatches.length === 1) return providerNameMatches[0];
		}
	}

	// Exact id match across all providers. Registry order is not a stable or
	// meaningful provider preference: the same OpenAI model can be registered
	// for both Azure and subscription-backed Codex. Match the ordering exposed
	// by the model picker so a bare ID cannot silently select an unconfigured
	// provider merely because it happened to appear first.
	const exactMatches = allModels.filter((m) => m.id.toLowerCase() === q);
	if (exactMatches.length > 0) return exactMatches.sort(compareProviderPreference)[0];

	// Unique substring match on id
	const idMatches = allModels.filter((m) => m.id.toLowerCase().includes(q));
	if (idMatches.length === 1) return idMatches[0];

	// Unique substring match on name
	const nameMatches = allModels.filter((m) => m.name.toLowerCase().includes(q));
	if (nameMatches.length === 1) return nameMatches[0];

	return undefined;
}

/**
 * List available models — only those with auth configured.
 * Without this filter, 700+ built-in models would flood the output.
 */
export function listModels(
	workingDir?: string,
	modelRegistry?: ModelRegistry,
): Array<{ provider: string; id: string; name: string; api: string }> {
	const current = getCurrentModelSelection(workingDir);
	const byKey = new Map<string, { provider: string; id: string; name: string; api: string }>();
	const addOption = (option: { provider: string; id: string; name: string; api: string }): void => {
		if (option.provider === "anthropic" && !ANTHROPIC_LISTED_MODELS.has(option.id)) return;
		byKey.set(modelKey(option.provider, option.id), option);
	};
	const addModel = (model: Model<Api>): void => addOption({
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
	});

	if (modelRegistry) {
		try {
			for (const model of modelRegistry.getAvailable()) addModel(model);
		} catch (err) {
			log.logWarning(
				"Model registry available-list failed",
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	for (const option of CURATED_MODEL_OPTIONS) addOption(option);
	if (isClaudeCliAuthenticated()) {
		for (const model of listClaudeCliModels()) addModel(model);
	}

	const currentKey = modelKey(current.provider, current.id);
	if (!byKey.has(currentKey)) {
		byKey.set(currentKey, {
			provider: current.provider,
			id: current.id,
			name: current.id,
			api: current.provider,
		});
	}

	return Array.from(byKey.values()).sort(compareModelOptions(currentKey));
}

function modelKey(provider: string, id: string): string {
	return `${provider.toLowerCase().trim()}/${id.toLowerCase().trim()}`;
}

function compareProviderPreference(
	a: { provider: string; id: string; name: string },
	b: { provider: string; id: string; name: string },
): number {
	const rankDelta = (MODEL_PROVIDER_RANK[a.provider] ?? 10) - (MODEL_PROVIDER_RANK[b.provider] ?? 10);
	if (rankDelta !== 0) return rankDelta;
	return a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function compareModelOptions(currentKey: string) {
	return (
		a: { provider: string; id: string; name: string },
		b: { provider: string; id: string; name: string },
	): number => {
		const aKey = modelKey(a.provider, a.id);
		const bKey = modelKey(b.provider, b.id);
		if (aKey === currentKey) return -1;
		if (bKey === currentKey) return 1;
		return compareProviderPreference(a, b);
	};
}

function readSettings(workingDir: string): { defaultProvider?: string; defaultModel?: string } {
	const settingsPath = join(workingDir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return {};
	}
}

/**
 * Apply provider-specific base URL overrides from env vars.
 * This lets the platform route traffic through a metering proxy.
 */
function applyBaseUrlOverride(model: Model<Api>, provider: string): Model<Api> {
	const overrides: Record<string, string | undefined> = {
		anthropic: process.env.ANTHROPIC_BASE_URL,
		openai: process.env.OPENAI_BASE_URL,
		"openai-codex": process.env.OPENAI_CODEX_BASE_URL,
		fireworks: process.env.FIREWORKS_BASE_URL,
		"cloudflare-workers-ai": process.env.CLOUDFLARE_WORKERS_AI_BASE_URL,
	};

	const override = overrides[provider];
	if (override) {
		return { ...model, baseUrl: override };
	}
	return model;
}

/**
 * Hostd reserves spend against this exact ceiling before proxying a request.
 * Mirror that owner-controlled bound into pi's model metadata so every real
 * Responses request stays within the reservation policy instead of relying on
 * individual callers to remember a lower maxTokens option.
 */
function applyMigratedHostdOutputBound(model: Model<Api>): Model<Api> {
	if (!isMigratedHostdOpenAi()) return model;
	if (model.provider !== HOSTD_OPENAI_PROVIDER || model.id !== HOSTD_OPENAI_MODEL_ID) {
		throw new Error(`Migrated Hostd contexts require ${HOSTD_OPENAI_PROVIDER}/${HOSTD_OPENAI_MODEL_ID}`);
	}
	const configured = process.env.MOM_MAX_OUTPUT_TOKENS?.trim();
	if (!configured || !/^[1-9]\d*$/.test(configured)) {
		throw new Error("Migrated Hostd contexts require a valid MOM_MAX_OUTPUT_TOKENS bound");
	}
	const maxTokens = Number(configured);
	if (!Number.isSafeInteger(maxTokens) || maxTokens < 16 || maxTokens > model.maxTokens) {
		throw new Error("Migrated Hostd MOM_MAX_OUTPUT_TOKENS is outside the pinned model limits");
	}
	return { ...model, maxTokens };
}

export class ModelCredentialUnavailableError extends Error {
	readonly code = "MODEL_CREDENTIAL_UNAVAILABLE";

	constructor(readonly provider: string) {
		super(
			`No API key found for provider "${provider}".\n\n` +
				`Set the appropriate API key environment variable, or configure auth.json.`,
		);
		this.name = "ModelCredentialUnavailableError";
	}
}

export function isModelCredentialUnavailableError(error: unknown): error is ModelCredentialUnavailableError {
	return error instanceof ModelCredentialUnavailableError
		|| (
			typeof error === "object"
			&& error !== null
			&& "code" in error
			&& error.code === "MODEL_CREDENTIAL_UNAVAILABLE"
		);
}

/**
 * Resolve API key for any provider through the canonical model runtime.
 * ModelRegistry checks runtime overrides, auth.json, OAuth, environment, and
 * provider-specific ambient credentials without exposing stored secrets.
 */
export async function resolveApiKey(modelRegistry: ModelRegistry, provider: string): Promise<string> {
	if (isMigratedHostdOpenAi()) {
		if (provider !== HOSTD_OPENAI_PROVIDER) {
			throw new ModelCredentialUnavailableError(provider);
		}
		const capability = process.env.OPENAI_API_KEY?.trim();
		if (!capability) throw new ModelCredentialUnavailableError(provider);
		return capability;
	}
	await modelRegistry.refresh();
	const key = await modelRegistry.getApiKeyForProvider(provider);
	if (!key) throw new ModelCredentialUnavailableError(provider);
	return key;
}
