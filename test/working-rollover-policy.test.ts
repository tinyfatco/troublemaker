import assert from "node:assert/strict";
import { shouldRolloverWorkingAfterToolCompletion } from "../src/streaming/working-rollover.js";

const activeReplyTarget = "slack:C123:1710000000.000001";
const delivered = { content: [{ type: "text", text: "sent" }], details: { delivered: true } };

assert.equal(shouldRolloverWorkingAfterToolCompletion({
	toolName: "send_message",
	isError: false,
	args: { target: activeReplyTarget },
	result: delivered,
	activeReplyTarget,
}), true, "successful send_message to the active locus rolls the working message");

assert.equal(shouldRolloverWorkingAfterToolCompletion({
	toolName: "send_message",
	isError: false,
	args: { target: activeReplyTarget },
	result: delivered,
	activeReplyTarget,
	workingStreamPresentation: "condensed",
}), false, "condensed presentation keeps editing the current working message after inline sends");

assert.equal(shouldRolloverWorkingAfterToolCompletion({
	toolName: "send_message",
	isError: false,
	args: { target: activeReplyTarget },
	result: delivered,
	activeReplyTarget,
	workingStreamPresentation: "split",
}), true, "split presentation rolls after inline sends");

assert.equal(shouldRolloverWorkingAfterToolCompletion({
	toolName: "send_message",
	isError: false,
	args: { target: `  ${activeReplyTarget}  ` },
	result: delivered,
	activeReplyTarget,
}), true, "target comparison ignores surrounding whitespace");

for (const [name, completion] of Object.entries({
	crossThread: {
		toolName: "send_message",
		isError: false,
		args: { target: "slack:C123:1710000000.000999" },
		result: delivered,
		activeReplyTarget,
	},
	crossChannel: {
		toolName: "send_message",
		isError: false,
		args: { target: "email-user@example.com" },
		result: delivered,
		activeReplyTarget,
	},
	failedSend: {
		toolName: "send_message",
		isError: false,
		args: { target: activeReplyTarget },
		result: { details: { delivered: false } },
		activeReplyTarget,
	},
	toolError: {
		toolName: "send_message",
		isError: true,
		args: { target: activeReplyTarget },
		result: delivered,
		activeReplyTarget,
	},
	otherTool: {
		toolName: "read",
		isError: false,
		args: { target: activeReplyTarget },
		result: delivered,
		activeReplyTarget,
	},
	missingLocus: {
		toolName: "send_message",
		isError: false,
		args: { target: activeReplyTarget },
		result: delivered,
		activeReplyTarget: undefined,
	},
})) {
	assert.equal(
		shouldRolloverWorkingAfterToolCompletion(completion),
		false,
		`${name} does not roll the current working message`,
	);
}

console.log("working-rollover-policy ok");
