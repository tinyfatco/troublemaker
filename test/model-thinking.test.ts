import assert from "node:assert/strict";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	boundCompactionStreamOptions,
	COMPACTION_MAX_OUTPUT_TOKENS,
	normalizeSimpleStreamOptionsForModel,
	normalizeThinkingLevel,
	normalizeThinkingLevelForModel,
	requiresEnabledThinking,
} from "../src/model-thinking.js";

const minimax = getModel("fireworks" as any, "accounts/fireworks/models/minimax-m2p7" as any);
const glm = getModel("fireworks" as any, "accounts/fireworks/models/glm-5p1" as any);

assert(minimax, "MiniMax M2.7 model exists");
assert(glm, "GLM Fireworks model exists");
assert.equal(requiresEnabledThinking(minimax), true);
assert.equal(requiresEnabledThinking(glm), false);

assert.equal(normalizeThinkingLevel("minimal"), "minimal");
assert.equal(normalizeThinkingLevel("bogus"), "off");
assert.equal(normalizeThinkingLevel(undefined), "off");

assert.equal(normalizeThinkingLevelForModel(minimax, undefined), "low");
assert.equal(normalizeThinkingLevelForModel(minimax, "off"), "low");
assert.equal(normalizeThinkingLevelForModel(minimax, "minimal"), "low");
assert.equal(normalizeThinkingLevelForModel(minimax, "low"), "low");
assert.equal(normalizeThinkingLevelForModel(minimax, "medium"), "medium");
assert.equal(normalizeThinkingLevelForModel(minimax, "high"), "high");
assert.equal(normalizeThinkingLevelForModel(minimax, "xhigh"), "high");
assert.equal(normalizeThinkingLevelForModel(minimax, "bogus"), "low");
assert.equal(normalizeSimpleStreamOptionsForModel(minimax, undefined)?.reasoning, "low");
assert.equal(normalizeSimpleStreamOptionsForModel(minimax, { maxTokens: 10 })?.reasoning, "low");
assert.equal(normalizeSimpleStreamOptionsForModel(minimax, { reasoning: "minimal" })?.reasoning, "low");
assert.equal(normalizeSimpleStreamOptionsForModel(minimax, { reasoning: "xhigh" })?.reasoning, "high");

assert.equal(normalizeThinkingLevelForModel(glm, "off"), "off");
assert.equal(normalizeThinkingLevelForModel(glm, "minimal"), "minimal");
assert.equal(normalizeThinkingLevelForModel(glm, "xhigh"), "xhigh");
assert.equal(normalizeSimpleStreamOptionsForModel(glm, { reasoning: "high" })?.reasoning, "high");

assert.equal(
	normalizeThinkingLevelForModel({ provider: "test", id: "test-model", reasoning: false }, "high"),
	"off",
);
assert.equal(
	normalizeSimpleStreamOptionsForModel({ provider: "test", id: "test-model", reasoning: false }, { reasoning: "high" })?.reasoning,
	undefined,
);

const ordinaryOptions = { maxTokens: 128000, reasoning: "xhigh" as const };
assert.equal(
	boundCompactionStreamOptions({ systemPrompt: "Ordinary agent prompt" }, ordinaryOptions),
	ordinaryOptions,
	"ordinary model turns retain their requested output and reasoning",
);
const compactOptions = boundCompactionStreamOptions(
	{ systemPrompt: "You are a context summarization assistant. Only summarize." },
	ordinaryOptions,
);
assert.equal(compactOptions?.maxTokens, COMPACTION_MAX_OUTPUT_TOKENS, "compaction output is capped independently of trigger headroom");
assert.equal(compactOptions?.reasoning, "low", "compaction does not inherit pathological xhigh reasoning");
assert.equal(
	boundCompactionStreamOptions(
		{ systemPrompt: "You are a context summarization assistant. Only summarize." },
		{ maxTokens: 2048 },
	)?.maxTokens,
	2048,
	"smaller branch-summary budgets remain intact",
);

console.log("model thinking tests passed");
