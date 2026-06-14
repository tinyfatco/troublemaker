import assert from "node:assert/strict";
import { createTroublemakerEdgeTurn } from "../src/modes/edge/troublemaker-extension.js";

const turn = createTroublemakerEdgeTurn(
	{ message: "hello", channelId: "web", source: "web" },
	{
		systemPrompt: "system",
		channelName: "web",
		workspaceContext: "Bootstrap:\nBegin onboarding from BOOTSTRAP.md.",
	},
	new Date("2026-06-14T12:34:56-05:00"),
);

assert.equal(turn.systemPrompt, "system");
const text = turn.promptMessage.content[0]?.type === "text" ? turn.promptMessage.content[0].text : "";
assert.match(text, /<session_context>/, "edge turn includes Troublemaker session context");
assert.match(text, /Attending: web \(web\)/, "edge turn marks the attended channel");
assert.match(text, /Bootstrap:\nBegin onboarding from BOOTSTRAP\.md\./, "edge turn carries workspace context through the session preamble");
assert.match(text, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] \[web\] \[user\]: hello/, "edge turn uses normal timestamp/channel/user framing");

console.log("edge session preamble ok");
