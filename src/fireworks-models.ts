import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";

export const GLM_5P2_MODEL_ID = "accounts/fireworks/models/glm-5p2";
export const DEFAULT_FIREWORKS_MODEL_ID = GLM_5P2_MODEL_ID;

const FIREWORKS_ANTHROPIC_COMPAT = {
	sendSessionAffinityHeaders: true,
	supportsEagerToolInputStreaming: false,
	supportsCacheControlOnTools: false,
	supportsLongCacheRetention: false,
} as const;

const GLM_5P2_MODEL = {
	id: GLM_5P2_MODEL_ID,
	name: "GLM 5.2",
	api: "anthropic-messages",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference",
	compat: FIREWORKS_ANTHROPIC_COMPAT,
	reasoning: true,
	input: ["text"],
	cost: {
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	},
	contextWindow: 1_048_576,
	maxTokens: 131_072,
} satisfies Model<"anthropic-messages">;

// Keep the explicitly supported legacy alias available even when upstream's
// generated catalog ages it out. Existing settings may still select it.
const GLM_5P1_MODEL = {
	id: "accounts/fireworks/models/glm-5p1",
	name: "GLM 5.1",
	api: "anthropic-messages",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference",
	compat: FIREWORKS_ANTHROPIC_COMPAT,
	reasoning: true,
	input: ["text"],
	cost: {
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	},
	contextWindow: 202_800,
	maxTokens: 131_072,
} satisfies Model<"anthropic-messages">;

const BUILTIN_FIREWORKS_MODELS = [GLM_5P2_MODEL, GLM_5P1_MODEL] satisfies Model<Api>[];

export function listBuiltinFireworksModels(): Model<Api>[] {
	return [...BUILTIN_FIREWORKS_MODELS];
}

export function getFireworksModel(modelId: string): Model<Api> | undefined {
	const builtin = BUILTIN_FIREWORKS_MODELS.find((model) => model.id === modelId);
	if (builtin) return builtin;
	return getModel("fireworks" as any, modelId as any) as Model<Api> | undefined;
}
