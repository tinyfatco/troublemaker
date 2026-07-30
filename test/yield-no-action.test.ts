import assert from "node:assert/strict";
import { createYieldNoActionTool, isYieldNoActionToolName, resetYield, wasYielded } from "../src/tools/yield-no-action.js";
import { TROUBLEMAKER_MCP_INSTRUCTIONS, YIELD_NO_ACTION_CONTRACT, YIELD_NO_ACTION_TOOL_DESCRIPTION } from "../src/yield-contract.js";

resetYield();

const tool = createYieldNoActionTool();
assert.equal(tool.description, YIELD_NO_ACTION_TOOL_DESCRIPTION, "yield tool exposes the canonical contract");
assert.match(tool.description, /agent-authored DM or group DM may end with `yield_no_action`/, "agent-authored direct closers may yield");
assert.match(tool.description, /human-authored DM, @mention, or direct request always requires a user-visible response/, "human direct messages still require replies");
assert.match(tool.description, /evaluated and intentionally quiet, not suppressed/, "yield records evaluated silence rather than input suppression");
assert.match(tool.description, /Never yield past an actionable handoff, safety issue, unresolved request/, "actionable agent handoffs still require handling");
assert(!YIELD_NO_ACTION_CONTRACT.includes("NEVER call this when someone has @mentioned you, sent you a DM"), "canonical contract removes the blanket DM prohibition");
assert(TROUBLEMAKER_MCP_INSTRUCTIONS.includes(YIELD_NO_ACTION_CONTRACT), "Claude MCP surfaces carry the identical yield contract");
const result = await tool.execute("test-call-id", { reason: "nothing to add" });

assert.equal(wasYielded(), true, "yield_no_action should mark the run as yielded");
assert.equal((result as any).terminate, true, "yield_no_action should terminate the agent loop");
assert.equal((result as any).details, undefined, "yield reason should stay internal-only");

resetYield();
assert.equal(wasYielded(), false, "resetYield should clear the yielded flag");
assert.equal(isYieldNoActionToolName("yield_no_action"), true, "plain yield tool is channel-silent");
assert.equal(isYieldNoActionToolName("functions.yield_no_action"), true, "namespaced yield tool is channel-silent");
assert.equal(isYieldNoActionToolName("send_message"), false, "other tools can still stream to channels");

console.log("yield_no_action terminates successfully");
