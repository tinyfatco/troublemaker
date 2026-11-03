import assert from "node:assert/strict";
import { LiveAssistantSnapshot } from "../src/streaming/live-turn-snapshot.js";
import { buildToolPresentation } from "../src/streaming/tool-presentation.js";

const msg = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as any;
const order = (s: LiveAssistantSnapshot) =>
	s.current(false)!.content.map((b: any) => b.type === "text" ? `text:${b.text}` : b.type === "toolCall" ? `call:${b.id}` : `${b.type}:${b.toolCallId}`);

// Claude CLI: one growing text block across MCP tool calls.
{
	const s = new LiveAssistantSnapshot();
	s.upsertToolCall("t0", "get_app_state", {});
	s.upsertToolResult("t0", "ok");
	s.beginAssistantMessage(msg("Blank tab."));
	s.upsertToolCall("t1", "set_value", {});
	s.upsertToolResult("t1", "ok");
	s.updateAssistantMessage(msg("Blank tab.\n\nNavigated."));
	s.upsertToolCall("t2", "click", {});
	s.upsertToolResult("t2", "ok");
	s.updateAssistantMessage(msg("Blank tab.\n\nNavigated.\n\nAt password"));
	s.endAssistantMessage(msg("Blank tab.\n\nNavigated.\n\nAt password screen."));
	assert.deepEqual(order(s), [
		"call:t0", "toolResult:t0",
		"text:Blank tab.", "call:t1", "toolResult:t1",
		"text:Navigated.", "call:t2", "toolResult:t2",
		"text:At password screen.",
	]);
	const p = buildToolPresentation(s.current(false), 1)!;
	assert.deepEqual(p.content.map((b) => b.type), ["toolCall", "toolResult", "text", "toolCall", "toolResult", "text", "toolCall", "toolResult", "text"]);
}

// Regular providers: tool call blocks inside the message are upserted, not frozen.
{
	const s = new LiveAssistantSnapshot();
	const withCall = { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "toolCall", id: "a", name: "bash", arguments: {} }], timestamp: 1 } as any;
	s.beginAssistantMessage(withCall);
	s.endAssistantMessage(withCall);
	s.upsertToolCall("a", "bash", { command: "ls" });
	s.upsertToolResult("a", "ok");
	s.beginAssistantMessage(msg("Done."));
	s.endAssistantMessage(msg("Done."));
	assert.deepEqual(order(s), ["text:Checking.", "call:a", "toolResult:a", "text:Done."]);
}
console.log("live-turn-snapshot interleave: ok");
