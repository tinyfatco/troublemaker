import assert from "node:assert/strict";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
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

console.log("model thinking tests passed");
