import assert from "node:assert/strict";
import { buildToolPresentation, TOOL_PRESENTATION_CUSTOM_TYPE } from "../src/streaming/tool-presentation.js";

assert.equal(TOOL_PRESENTATION_CUSTOM_TYPE, "troublemaker.tool-presentation");

const entry = {
	id: "live-assistant",
	type: "message" as const,
	timestamp: "2026-11-02T22:00:00.000Z",
	role: "assistant" as const,
	content: [
		{ type: "thinking" as const, thinking: "private" },
		{ type: "text" as const, text: "Checking." },
		{ type: "toolCall" as const, id: "t1", name: "bash", label: "Run tests", arguments: { command: "x".repeat(500), timeout: 60, nested: { a: 1 } } },
		{ type: "toolOutput" as const, toolCallId: "t1", stream: "stdout" as const, text: "lots of output" },
		{ type: "toolResult" as const, toolCallId: "t1", result: "full result text", isError: true },
		{ type: "text" as const, text: "Done." },
	],
};

const data = buildToolPresentation(entry as any, 1762120800000);
assert.ok(data);
assert.equal(data.messageTimestamp, 1762120800000);
assert.deepEqual(data.content.map((block) => block.type), ["text", "toolCall", "toolResult", "text"]);
const call = data.content[1] as any;
assert.equal(call.label, "Run tests");
assert.equal(call.arguments.timeout, 60);
assert.equal(call.arguments.command.length, 301, "long strings are truncated");
assert.equal(call.arguments.nested, '{"a":1}');
assert.deepEqual(data.content[2], { type: "toolResult", toolCallId: "t1", isError: true }, "results keep only status");
assert.ok(!JSON.stringify(data).includes("private"), "thinking is never persisted");

assert.equal(buildToolPresentation({ ...entry, content: [{ type: "text", text: "hi" }] } as any, 1), null, "text-only turns need no record");
assert.equal(buildToolPresentation(null, 1), null);
assert.equal(buildToolPresentation(entry as any, Number.NaN), null);
console.log("tool-presentation tests passed");
