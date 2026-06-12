import {
	getToolDetail,
	getToolStatus,
	getToolStatusText,
	getToolTitle,
	humanizeToolName,
	summarizeToolResult,
} from "../ui/src/toolDisplay.ts";
import type { ToolCallContent, ToolResultContent } from "../ui/src/types.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

const bashCall: ToolCallContent = {
	type: "toolCall",
	id: "tool-1",
	name: "bash",
	arguments: {
		label: "Find WorkspaceLayout source",
		command: "rg -n \"WorkspaceLayout\" ui/src",
	},
};

const result: ToolResultContent = {
	type: "toolResult",
	toolCallId: "tool-1",
	result: "one\ntwo\nthree",
};

const yieldNoActionCall: ToolCallContent = {
	type: "toolCall",
	id: "tool-2",
	name: "yield_no_action",
	arguments: {
		reason: "heartbeat only; nothing useful to add",
	},
};

const namespacedYieldNoActionCall: ToolCallContent = {
	type: "toolCall",
	id: "tool-3",
	name: "functions.yield_no_action",
	arguments: {
		reason: "ambient conversation; no direct address",
	},
};

const sendTelegramCall: ToolCallContent = {
	type: "toolCall",
	id: "tool-4",
	name: "send_message",
	arguments: {
		label: "Tell Alex",
		target: "123456789",
		text: "I'll take a look and send the draft shortly.",
	},
};

const sendEmailCall: ToolCallContent = {
	type: "toolCall",
	id: "tool-5",
	name: "functions.send_message",
	arguments: {
		target: "email-alex@tinyfat.com",
		text: "Line one\nLine two with a little more detail",
	},
};

const configureCall: ToolCallContent = {
	type: "toolCall",
	id: "tool-6",
	name: "configure",
	arguments: {
		description: "Update heartbeat level",
		target: "spontaneity.level",
		value: 4,
	},
};

const selfConfigureCall: ToolCallContent = {
	type: "toolCall",
	id: "tool-7",
	name: "self_configure",
	arguments: {
		label: "Change thinking level",
		setting: "thinking_level",
		value: "high",
	},
};

const sensitiveConfigureCall: ToolCallContent = {
	type: "toolCall",
	id: "tool-8",
	name: "functions.configure",
	arguments: {
		description: "Update Google credentials",
		target: "secrets.gog_credentials",
		value: { client_id: "abc", client_secret: "def" },
	},
};

assert(getToolTitle(bashCall) === "Find WorkspaceLayout source", "tool title prefers human label over raw tool name");
assert(getToolDetail(bashCall) === "rg -n \"WorkspaceLayout\" ui/src", "tool detail uses command as secondary text");
assert(getToolDetail(yieldNoActionCall) === "heartbeat only; nothing useful to add", "yield_no_action reason is shown as secondary text");
assert(getToolDetail(namespacedYieldNoActionCall) === "ambient conversation; no direct address", "namespaced yield_no_action reason is shown as secondary text");
assert(getToolDetail(sendTelegramCall) === "Telegram: I'll take a look and send the draft shortly.", "send_message shows destination and message preview");
assert(getToolDetail(sendEmailCall) === "Email alex@tinyfat.com: Line one Line two with a little more detail", "send_message aliases show destination and collapsed message preview");
assert(getToolTitle(configureCall) === "Update heartbeat level", "configure title still uses the description");
assert(getToolDetail(configureCall) === "spontaneity.level = 4", "configure detail shows target and value as secondary text");
assert(getToolDetail(selfConfigureCall) === "thinking_level = high", "self_configure detail shows setting and value as secondary text");
assert(getToolDetail(sensitiveConfigureCall) === "secrets.gog_credentials = [redacted]", "configure detail redacts sensitive-looking values");
assert(getToolStatus(false) === "done", "historical tool call without a result is done, not pending");
assert(getToolStatus(true, result) === "running", "streaming unresolved call is running");
assert(getToolStatus(false, { ...result, isError: true }) === "error", "errored result reports error");
assert(getToolStatusText("done", result) === "", "completed tool status omits redundant done text");
assert(summarizeToolResult(result.result) === "3 lines", "result summaries remain available for compact output metadata");
assert(humanizeToolName("send_message") === "Send Message", "fallback tool names are readable");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
