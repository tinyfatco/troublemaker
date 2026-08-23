import type { ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const COMPACTION_SYSTEM_PROMPT_PREFIX = "You are a context summarization assistant.";
export const COMPACTION_MAX_OUTPUT_TOKENS = 8192;

export type RuntimeThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

type RuntimeModel = {
	id?: string;
	provider?: string;
	reasoning?: boolean;
};

function supportsMaximumThinking(model: RuntimeModel): boolean {
	return model.provider === "openai" && model.id === "gpt-5.6-luna";
}

export function normalizeThinkingLevel(value: unknown): RuntimeThinkingLevel {
	return typeof value === "string" && (MODEL_THINKING_LEVELS as readonly string[]).includes(value)
		? (value as RuntimeThinkingLevel)
		: "off";
}

export function requiresEnabledThinking(model: RuntimeModel): boolean {
	return model.provider === "fireworks" && /^accounts\/fireworks\/models\/minimax-m2/.test(model.id ?? "");
}

export function normalizeThinkingLevelForModel(model: RuntimeModel, requested: unknown): ModelThinkingLevel {
	let level = normalizeThinkingLevel(requested);
	if (!model.reasoning && !requiresEnabledThinking(model)) return "off";
	if (level === "max" && !supportsMaximumThinking(model)) level = "xhigh";
	if (!requiresEnabledThinking(model)) return level;
	if (level === "max") return "max";
	if (level === "medium" || level === "high") return level;
	if (level === "xhigh") return "high";
	return "low";
}

export function normalizeSimpleStreamOptionsForModel(
	model: RuntimeModel,
	options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
	const effective = normalizeThinkingLevelForModel(model, options?.reasoning);
	if (effective === "off") {
		if (!options?.reasoning) return options;
		const { reasoning: _reasoning, ...rest } = options;
		return rest;
	}
	return { ...options, reasoning: effective };
}

export function applyMigratedHostdStreamPolicy(
	options: SimpleStreamOptions | undefined,
): SimpleStreamOptions | undefined {
	return process.env.TROUBLEMAKER_HOSTD_OPENAI_MIGRATED === "1"
		? { ...options, maxRetries: 0 }
		: options;
}

/**
 * Pi uses compaction reserveTokens both as the trigger headroom and as the
 * summary output budget. Percentage-based triggers can therefore inflate a
 * concise summary request to the model maximum. Bound only the summarization
 * request while preserving the independently derived trigger threshold.
 */
export function boundCompactionStreamOptions(
	context: { systemPrompt?: string },
	options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
	if (!context.systemPrompt?.startsWith(COMPACTION_SYSTEM_PROMPT_PREFIX)) return options;
	return {
		...options,
		maxTokens: Math.min(options?.maxTokens ?? COMPACTION_MAX_OUTPUT_TOKENS, COMPACTION_MAX_OUTPUT_TOKENS),
		reasoning: process.env.TROUBLEMAKER_HOSTD_OPENAI_MIGRATED === "1" ? "max" : "low",
	};
}
