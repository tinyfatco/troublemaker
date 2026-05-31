import assert from "node:assert/strict";
import { sanitizeMessages } from "../src/sanitize.js";

{
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "peekaboo__see", arguments: {} }],
		},
		{
			role: "toolResult",
			toolCallId: "tool-1",
			content: [{ type: "text", text: "ok" }],
		},
	];

	assert.deepEqual(sanitizeMessages(messages), messages);
}

{
	const messages = [
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "tool-1", name: "peekaboo__see", input: {} }],
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
		},
	];

	assert.deepEqual(sanitizeMessages(messages), messages);
}

{
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "peekaboo__see", arguments: {} }],
		},
		{
			role: "toolResult",
			toolCallId: "missing-tool",
			content: [{ type: "text", text: "orphaned" }],
		},
	];

	assert.deepEqual(sanitizeMessages(messages), [messages[0]]);
}

console.log("sanitize tests passed");
