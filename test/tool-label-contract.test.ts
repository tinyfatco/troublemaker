import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { wrapMcpTool } from "../src/mcp-client/wrap-tool.js";
import {
	addRequiredToolLabelToSchema,
	enforceRequiredToolLabel,
	requireNonblankToolLabel,
	stripToolPresentationArgs,
} from "../src/tools/tool-label.js";

const calls: unknown[] = [];
const baseTool: AgentTool<any> = {
	name: "unlabeled_extension_tool",
	label: "unlabeled extension tool",
	description: "Fixture that starts without a label parameter",
	parameters: Type.Object({ value: Type.String() }),
	execute: async (_id, params) => {
		calls.push(params);
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

const enforced = enforceRequiredToolLabel(baseTool);
assert.equal(Check(enforced.parameters, { value: "x" }), true, "missing labels never reject an otherwise valid call");
assert.equal(Check(enforced.parameters, { label: "", value: "x" }), true, "blank labels fall back at execution instead of failing schema validation");
assert.equal(Check(enforced.parameters, { label: "   ", value: "x" }), true, "whitespace labels remain non-fatal");
assert.equal(Check(enforced.parameters, { label: "Do the thing", value: "x" }), true, "surfaced schemas accept useful labels");
assert.match(JSON.stringify(enforced.parameters), /Strongly recommended/i, "model-facing schema still strongly encourages a label");

await (enforced.execute as any)("missing", { value: "x" });
await (enforced.execute as any)("blank", { label: " \n ", value: "x" });
await (enforced.execute as any)("valid", { label: "  Do the thing  ", value: "x" });
assert.deepEqual(calls, [
	{ value: "x", label: "Unlabeled extension tool" },
	{ label: "Unlabeled extension tool", value: "x" },
	{ label: "Do the thing", value: "x" },
], "runtime injects a readable fallback and trims useful labels before execution");
assert.equal(requireNonblankToolLabel({ label: "  Visible step  " }), "Visible step", "runtime returns a trimmed label");
assert.equal(requireNonblankToolLabel({}, "read_file"), "Read file", "runtime resolves an omitted label from the tool name");

const augmented = addRequiredToolLabelToSchema(Type.Object({ target: Type.String() }));
assert.equal(Check(augmented, { target: "C123" }), true, "schema augmentation keeps label optional");
assert.equal(Check(augmented, { label: "", target: "C123" }), true, "blank presentation metadata does not reject the call");
assert.equal(Check(augmented, { label: "Send update", target: "C123" }), true, "schema augmentation preserves original fields");
assert.deepEqual(
	stripToolPresentationArgs({ label: "Visible", show: true, target: "C123", nested: { ok: true } }),
	{ target: "C123", nested: { ok: true } },
	"presentation metadata is stripped without altering MCP arguments",
);

const forwarded: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
const fakeClient = {
	callTool: async (request: { name: string; arguments?: Record<string, unknown> }) => {
		forwarded.push(request);
		return { content: [{ type: "text", text: "forwarded" }] };
	},
} as any;
const wrapped = wrapMcpTool("fixture", {
	name: "remote_action",
	description: "Remote action",
	inputSchema: {
		type: "object",
		properties: { target: { type: "string" } },
		required: ["target"],
	},
} as any, fakeClient);

assert.equal(Check(wrapped.parameters, { target: "one" }), true, "wrapped MCP schema keeps label optional");
assert.equal(Check(wrapped.parameters, { label: "  ", target: "one" }), true, "blank MCP labels remain non-fatal");
await (wrapped.execute as any)("wrapped-missing", { target: "one" });
await (wrapped.execute as any)("wrapped-valid", { label: "Run remote action", show: true, target: "one" });
assert.deepEqual(
	forwarded,
	[
		{ name: "remote_action", arguments: { target: "one" } },
		{ name: "remote_action", arguments: { target: "one" } },
	],
	"wrapped MCP forwarding strips fallback labels and show metadata",
);

console.log("tool label contract ok");
