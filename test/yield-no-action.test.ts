import assert from "node:assert/strict";
import { createYieldNoActionTool, resetYield, wasYielded } from "../src/tools/yield-no-action.js";

resetYield();

const tool = createYieldNoActionTool();
const result = await tool.execute("test-call-id", { reason: "nothing to add" });

assert.equal(wasYielded(), true, "yield_no_action should mark the run as yielded");
assert.equal((result as any).terminate, true, "yield_no_action should terminate the agent loop");
assert.equal((result as any).details, undefined, "yield reason should stay internal-only");

resetYield();
assert.equal(wasYielded(), false, "resetYield should clear the yielded flag");

console.log("yield_no_action terminates successfully");
