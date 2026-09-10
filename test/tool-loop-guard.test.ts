import assert from "node:assert/strict";
import { ToolLoopGuard, TOOL_LOOP_STOP_MESSAGE } from "../src/tool-loop-guard.js";

const guard = new ToolLoopGuard();
const record = (path = "example.txt", result = "unchanged", label = "Read", isError = false) =>
	guard.record("read", { path, label }, [{ type: "text", text: result }], isError);
assert.equal(record(), undefined);
assert.equal(record(), undefined);
assert.equal(record("example.txt", "unchanged", "Inspect again"), "warn");
assert.equal(record(), "warn");
assert.equal(record(), "stop");
assert.equal(guard.stopped, true);
guard.reset();
assert.equal(record(), undefined, "fresh runs can retry the same operation");
for (let i = 0; i < 100; i++) assert.equal(record("example.txt", `progress ${i}`), undefined);
guard.reset();
for (let i = 0; i < 4; i++) { record("a.txt"); record("b.txt"); }
record("a.txt");
record("b.txt");
assert.equal(guard.stopped, true, "alternating unchanged cycles stop");
guard.reset();
for (let i = 0; i < 4; i++) record("example.txt", "synthetic failure", "Read", true);
assert.equal(record("example.txt", "synthetic failure", "Read", true), "stop");
guard.reset();
for (let i = 0; i < 100; i++) assert.equal(record(`file-${i}.txt`), undefined, "different work is allowed");

guard.reset();
for (let i = 0; i < 5; i++) guard.record("call_tool", {name: "read", arguments: {path: "example.txt", label: `Read ${i}`}}, "unchanged", false);
assert.equal(guard.stopped, true, "compact routing labels cannot evade detection");

const handlers: Record<string, Function> = {};
guard.reset();
guard.extension({ on: (name: string, handler: Function) => { handlers[name] = handler; } } as any);
let aborted = 0;
const event = { toolName: "read", input: { path: "example.txt" }, content: [{ type: "text", text: "unchanged" }], isError: false };
for (let i = 0; i < 5; i++) {
	const result = handlers.tool_result(event, { abort: () => { aborted++; } });
	if (i === 2) assert.match(result.content[1].text, /Change your approach/);
}
assert.equal(aborted, 1);
assert.deepEqual(handlers.tool_call(), { block: true, terminate: true, reason: TOOL_LOOP_STOP_MESSAGE });
guard.reset();
assert.equal(handlers.tool_call(), undefined);
console.log("tool loop guard ok");
