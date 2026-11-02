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

// Pi 1.x's generated catalog dropped these; the `minimax` and `deepseek`
// aliases (model-config.ts) still select them. Definitions copied verbatim
// from the pi-ai 0.84.2 catalog.
const MINIMAX_M2P7_MODEL = {
	id: "accounts/fireworks/models/minimax-m2p7",
	name: "MiniMax-M2.7",
	api: "anthropic-messages",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference",
	compat: FIREWORKS_ANTHROPIC_COMPAT,
	reasoning: true,
	input: ["text"],
	cost: {
		input: 0.3,
		output: 1.2,
		cacheRead: 0.06,
		cacheWrite: 0,
	},
	contextWindow: 196_608,
	maxTokens: 196_608,
} satisfies Model<"anthropic-messages">;

const DEEPSEEK_V4_PRO_MODEL = {
	id: "accounts/fireworks/models/deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "anthropic-messages",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference",
	compat: FIREWORKS_ANTHROPIC_COMPAT,
	reasoning: true,
	input: ["text"],
	cost: {
		input: 1.74,
		output: 3.48,
		cacheRead: 0.145,
		cacheWrite: 0,
	},
	contextWindow: 1_000_000,
	maxTokens: 384_000,
} satisfies Model<"anthropic-messages">;

const BUILTIN_FIREWORKS_MODELS = [GLM_5P2_MODEL, GLM_5P1_MODEL, MINIMAX_M2P7_MODEL, DEEPSEEK_V4_PRO_MODEL] satisfies Model<Api>[];

export function listBuiltinFireworksModels(): Model<Api>[] {
	return [...BUILTIN_FIREWORKS_MODELS];
}

export function getFireworksModel(modelId: string): Model<Api> | undefined {
	const builtin = BUILTIN_FIREWORKS_MODELS.find((model) => model.id === modelId);
	if (builtin) return builtin;
	return getModel("fireworks" as any, modelId as any) as Model<Api> | undefined;
}
