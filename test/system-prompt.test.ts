import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/core/prompt.js";

const prompt = buildSystemPrompt(
	"/data",
	{ type: "host" },
	"format instructions",
	{
		id: "test-model",
		provider: "test-provider",
	},
);

assert(prompt.includes("Use the `scheduling` skill"), "system prompt points scheduling/calendar work to the scheduling skill");
assert(prompt.includes("send_message"), "system prompt names send_message");
assert(!prompt.includes("send_message_to_channel"), "system prompt no longer names send_message_to_channel");
assert(prompt.includes("list_channels"), "system prompt names list_channels");
assert(prompt.includes("recent Slack thread targets"), "system prompt says list_channels discovers Slack threads");
assert(prompt.includes("do not collapse distinct thread roots together"), "system prompt preserves Slack thread distinctions");
assert(prompt.includes("self_configure"), "system prompt names self_configure");
assert(prompt.includes("yield_no_action"), "system prompt names yield_no_action");
assert(!prompt.includes("Use `ping`"), "system prompt no longer instructs the ping tool");
assert(!prompt.includes("ping (cross-channel messaging)"), "system prompt no longer lists ping as cross-channel messaging");
assert(!prompt.includes("## Calendar Events"), "calendar event details moved out of the system prompt");
assert(!prompt.includes("## Attention Queue"), "attention queue details moved out of the system prompt");

console.log("system-prompt ok");
