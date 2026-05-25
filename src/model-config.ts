/**
 * Model resolution and runtime switching.
 *
 * Priority: env vars > settings.json > defaults.
 *
 * Models are resolved through ModelRegistry so built-in pi-ai providers plus
 * any workspace models.json entries are available to /model and runtime resolution.
 */

import { getModel, type Api, type Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

const DEFAULT_PROVIDER = "fireworks";
const DEFAULT_MODEL_ID = "accounts/fireworks/models/minimax-m2p7";

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
	glm: "accounts/fireworks/models/glm-5p1",
	glm5: "accounts/fireworks/models/glm-5p1",
	"glm-5p1": "accounts/fireworks/models/glm-5p1",
	"glm-5.1": "accounts/fireworks/models/glm-5p1",
	qwen: "accounts/fireworks/models/qwen3p6-plus",
	"qwen3p6": "accounts/fireworks/models/qwen3p6-plus",
	"qwen3.6": "accounts/fireworks/models/qwen3p6-plus",
	"glm-fast": "accounts/fireworks/routers/glm-5p1-fast",
	"kimi-turbo": "accounts/fireworks/routers/kimi-k2p6-turbo",
};

function createWorkspaceModelRegistry(workingDir?: string): ModelRegistry {
	const authStorage = AuthStorage.create();
	const modelsJsonPath = workingDir ? join(workingDir, "models.json") : undefined;
	return ModelRegistry.create(authStorage, modelsJsonPath);
}

function getRegistryModels(workingDir?: string, modelRegistry?: ModelRegistry): Model<Api>[] {
	if (modelRegistry) {
		modelRegistry.refresh();
		return modelRegistry.getAll();
	}
	return createWorkspaceModelRegistry(workingDir).getAll();
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
 * 3. fireworks / accounts/fireworks/models/minimax-m2p7
 */
export function resolveModel(workingDir?: string, modelRegistry?: ModelRegistry): Model<Api> {
	const { provider, id: modelId } = getCurrentModelSelection(workingDir);

	const models = getRegistryModels(workingDir, modelRegistry);

	let model = findExactModel(models, provider, modelId);
	if (!model) {
		model = resolveFireworksAliasModel(models, modelId, provider);
	}

	if (!model) {
		log.logWarning(
			`Model not found: ${provider}/${modelId}`,
			`Falling back to ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`,
		);

		const fallback =
			findExactModel(models, DEFAULT_PROVIDER, DEFAULT_MODEL_ID) ||
			getModel(DEFAULT_PROVIDER as any, DEFAULT_MODEL_ID as any);
		if (!fallback) {
			throw new Error(`Default model ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID} not found`);
		}
		return applyBaseUrlOverride(fallback, fallback.provider);
	}

	log.logInfo(`Model: ${model.provider}/${model.id} (api: ${model.api})`);
	return applyBaseUrlOverride(model, model.provider);
}

export function getCurrentModelSelection(workingDir?: string): { provider: string; id: string } {
	let provider = process.env.MOM_MODEL_PROVIDER;
	let modelId = process.env.MOM_MODEL_ID;

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

	// Exact id match across all providers
	const exact = allModels.find((m) => m.id.toLowerCase() === q);
	if (exact) return exact;

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
	const registry = modelRegistry || createWorkspaceModelRegistry(workingDir);
	return registry.getAvailable()
		.filter((model) => {
			// For Anthropic, only show the models people actually want
			if (model.provider === "anthropic") {
				return ANTHROPIC_LISTED_MODELS.has(model.id);
			}
			return true;
		})
		.map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			api: model.api,
		}));
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
	};

	const override = overrides[provider];
	if (override) {
		return { ...model, baseUrl: override };
	}
	return model;
}

/**
 * Resolve API key for any provider via AuthStorage.
 * AuthStorage checks: runtime override → auth.json → OAuth token → env var → fallback.
 */
export async function resolveApiKey(authStorage: AuthStorage, provider: string): Promise<string> {
	const key = await authStorage.getApiKey(provider);
	if (!key) {
		throw new Error(
			`No API key found for provider "${provider}".\n\n` +
				`Set the appropriate API key environment variable, or configure auth.json.`,
		);
	}
	return key;
}
