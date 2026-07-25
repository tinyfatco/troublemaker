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
assert.equal(Check(enforced.parameters, { value: "x" }), false, "surfaced schemas require label");
assert.equal(Check(enforced.parameters, { label: "", value: "x" }), false, "surfaced schemas reject empty label");
assert.equal(Check(enforced.parameters, { label: "   ", value: "x" }), false, "surfaced schemas reject whitespace-only label");
assert.equal(Check(enforced.parameters, { label: "Do the thing", value: "x" }), true, "surfaced schemas accept nonblank label");

await assert.rejects(
	(enforced.execute as any)("missing", { value: "x" }),
	/requires a nonblank label/,
	"runtime rejects missing labels even when execution bypasses schema validation",
);
await assert.rejects(
	(enforced.execute as any)("blank", { label: " \n ", value: "x" }),
	/requires a nonblank label/,
	"runtime rejects blank labels even when execution bypasses schema validation",
);
await (enforced.execute as any)("valid", { label: "Do the thing", value: "x" });
assert.equal(calls.length, 1, "only nonblank labeled calls reach the underlying tool");
assert.equal(requireNonblankToolLabel({ label: "  Visible step  " }), "Visible step", "runtime returns a trimmed label");

const augmented = addRequiredToolLabelToSchema(Type.Object({ target: Type.String() }));
assert.equal(Check(augmented, { target: "C123" }), false, "schema augmentation makes label required");
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

assert.equal(Check(wrapped.parameters, { target: "one" }), false, "wrapped MCP schema requires label");
assert.equal(Check(wrapped.parameters, { label: "  ", target: "one" }), false, "wrapped MCP schema rejects blank label");
await assert.rejects(
	(wrapped.execute as any)("wrapped-missing", { target: "one" }),
	/requires a nonblank label/,
	"wrapped MCP runtime rejects missing label",
);
await (wrapped.execute as any)("wrapped-valid", { label: "Run remote action", show: true, target: "one" });
assert.deepEqual(
	forwarded,
	[{ name: "remote_action", arguments: { target: "one" } }],
	"wrapped MCP forwarding strips label and show",
);

console.log("tool label contract ok");
