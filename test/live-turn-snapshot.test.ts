import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { LiveAssistantSnapshot } from "../src/streaming/live-turn-snapshot.js";

function assistant(...texts: string[]): AgentMessage {
	return {
		role: "assistant",
		content: texts.map((text) => ({ type: "text", text })),
		timestamp: Date.parse("2040-01-01T00:00:00Z"),
	} as unknown as AgentMessage;
}

function order(snapshot: LiveAssistantSnapshot): string[] {
	return (snapshot.current()?.content || []).map((block) => {
		if (block.type === "text") return `text:${block.text}`;
		if (block.type === "toolCall") return `call:${block.id}`;
		if (block.type === "toolResult") return `result:${block.toolCallId}`;
		return block.type;
	});
}

// One streamed message spanning several tool rounds (Claude CLI) keeps text and
// tools in arrival order instead of piling all text ahead of the tools.
{
	const snapshot = new LiveAssistantSnapshot();
	snapshot.beginAssistantMessage(assistant("Checking."));
	snapshot.upsertToolCall("tool-1", "bash", {}, "First");
	snapshot.updateAssistantMessage(assistant("Checking."));
	snapshot.upsertToolResult("tool-1", "ok");
	snapshot.updateAssistantMessage(assistant("Checking.", "Found"));
	snapshot.updateAssistantMessage(assistant("Checking.", "Found it."));
	snapshot.upsertToolCall("tool-2", "bash", {}, "Second");
	snapshot.upsertToolResult("tool-2", "ok");
	snapshot.endAssistantMessage(assistant("Checking.", "Found it.", "Done."));
	assert.deepEqual(order(snapshot), [
		"text:Checking.",
		"call:tool-1",
		"result:tool-1",
		"text:Found it.",
		"call:tool-2",
		"result:tool-2",
		"text:Done.",
	]);
}

// Providers that finish the message before running tools are unchanged.
{
	const snapshot = new LiveAssistantSnapshot();
	snapshot.beginAssistantMessage(assistant("Plan."));
	snapshot.endAssistantMessage(assistant("Plan."));
	snapshot.upsertToolCall("tool-1", "bash", {}, "Run");
	snapshot.upsertToolResult("tool-1", "ok");
	snapshot.beginAssistantMessage(assistant("Result."));
	snapshot.endAssistantMessage(assistant("Result."));
	assert.deepEqual(order(snapshot), ["text:Plan.", "call:tool-1", "result:tool-1", "text:Result."]);
}

console.log("live-turn-snapshot ok");
