/**
 * Model resolution and runtime switching.
 *
 * Priority: env vars > settings.json > defaults.
 *
 * Pi's getModel() returns the full Model object with api type, baseUrl,
 * cost, context window, etc. Pi's streamSimple() then dispatches to the
 * correct stream function based on model.api (anthropic-messages,
 * openai-codex-responses, openai-responses, etc).
 */

import { getModel, getModels, getProviders, type Api, type KnownProvider, type Model } from "@mariozechner/pi-ai";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

/**
 * Resolve the model from env vars or settings.json, falling back to defaults.
 *
 * Priority:
 * 1. MOM_MODEL_PROVIDER + MOM_MODEL_ID env vars (set by platform)
 * 2. settings.json defaultProvider + defaultModel (set by /model command or agent)
 * 3. anthropic / claude-sonnet-4-5
 */
export function resolveModel(workingDir?: string): Model<Api> {
	// 1. Env vars (highest priority — set by platform/spider-relay)
	let provider = process.env.MOM_MODEL_PROVIDER;
	let modelId = process.env.MOM_MODEL_ID;

	// 2. settings.json (set by /model command or agent bash)
	if ((!provider || !modelId) && workingDir) {
		const settings = readSettings(workingDir);
		if (!provider && settings.defaultProvider) provider = settings.defaultProvider;
		if (!modelId && settings.defaultModel) modelId = settings.defaultModel;
	}

	// 3. Defaults
	provider = provider || DEFAULT_PROVIDER;
	modelId = modelId || DEFAULT_MODEL_ID;

	const model = getModel(provider as any, modelId as any);
	if (!model) {
		log.logWarning(
			`Model not found: ${provider}/${modelId}`,
			`Falling back to ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`,
		);
		const fallback = getModel("anthropic", "claude-sonnet-4-5");
		if (!fallback) {
			throw new Error("Default model anthropic/claude-sonnet-4-5 not found in Pi registry");
		}
		return applyBaseUrlOverride(fallback, DEFAULT_PROVIDER);
	}

	log.logInfo(`Model: ${provider}/${modelId} (api: ${model.api})`);
	return applyBaseUrlOverride(model, provider);
}

/**
 * Find a model by fuzzy matching against provider/id.
 * Accepts formats like "gpt-5.1", "anthropic/claude-sonnet-4-5", "sonnet", etc.
 */
export function findModel(query: string): Model<Api> | undefined {
	const q = query.toLowerCase().trim();

	// Try exact provider/model match first
	if (q.includes("/")) {
		const [provider, modelId] = q.split("/", 2);
		const model = getModel(provider as any, modelId as any);
		if (model) return model;
	}

	// Search all models for substring match on id or name
	const allModels: Model<Api>[] = [];
	for (const provider of getProviders()) {
		allModels.push(...(getModels(provider as KnownProvider) as Model<Api>[]));
	}

	// Exact id match
	const exact = allModels.find((m) => m.id.toLowerCase() === q);
	if (exact) return exact;

	// Substring match on id
	const matches = allModels.filter((m) => m.id.toLowerCase().includes(q));
	if (matches.length === 1) return matches[0];

	// Substring match on name
	const nameMatches = allModels.filter((m) => m.name.toLowerCase().includes(q));
	if (nameMatches.length === 1) return nameMatches[0];

	return undefined;
}

/**
 * List available models (for /model command with no args).
 */
export function listModels(): Array<{ provider: string; id: string; name: string; api: string }> {
	const result: Array<{ provider: string; id: string; name: string; api: string }> = [];
	for (const provider of getProviders()) {
		for (const model of getModels(provider as KnownProvider) as Model<Api>[]) {
			result.push({ provider: model.provider, id: model.id, name: model.name, api: model.api });
		}
	}
	return result;
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
