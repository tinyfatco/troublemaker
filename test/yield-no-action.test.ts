import assert from "node:assert/strict";
import { createYieldNoActionTool, isYieldNoActionToolName, resetYield, wasYielded } from "../src/tools/yield-no-action.js";

resetYield();

const tool = createYieldNoActionTool();
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
