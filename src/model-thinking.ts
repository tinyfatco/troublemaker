import type { ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type RuntimeThinkingLevel = (typeof THINKING_LEVELS)[number];

type RuntimeModel = {
	id?: string;
	provider?: string;
	reasoning?: boolean;
};

export function normalizeThinkingLevel(value: unknown): RuntimeThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as RuntimeThinkingLevel)
		: "off";
}

export function requiresEnabledThinking(model: RuntimeModel): boolean {
	return model.provider === "fireworks" && /^accounts\/fireworks\/models\/minimax-m2/.test(model.id ?? "");
}

export function normalizeThinkingLevelForModel(model: RuntimeModel, requested: unknown): ModelThinkingLevel {
	const level = normalizeThinkingLevel(requested);
	if (!model.reasoning && !requiresEnabledThinking(model)) return "off";
	if (!requiresEnabledThinking(model)) return level;
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
