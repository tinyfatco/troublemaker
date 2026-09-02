import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RuntimeAssistantTextEvent } from "../src/core/runtime-contract.js";
import { RuntimeLiveEventHub, projectRuntimeEventForTerminal } from "../src/live-events.js";
import { AssistantTextProjection } from "../src/streaming/assistant-text-projection.js";

const projection = new AssistantTextProjection(() => new Date("2026-08-17T15:00:00.000Z"));
projection.reset("completion-example-0001");

assert.equal(projection.begin(assistantMessage([])), null);
assert.equal(
	projection.update(assistantMessage([
		{ type: "thinking", thinking: "PRIVATE_REASONING" },
		{ type: "toolCall", id: "tool-example", name: "example_tool", arguments: { secret: "PRIVATE_ARGUMENT" } },
	]), "thinking_delta"),
	null,
);

const firstPatch = projection.update(assistantMessage([
	{ type: "thinking", thinking: "PRIVATE_REASONING" },
	{ type: "text", text: "First " },
	{ type: "toolCall", id: "tool-example", name: "example_tool", arguments: { secret: "PRIVATE_ARGUMENT" } },
]), "text_delta");
assert.deepEqual(firstPatch, {
	type: "assistant_text",
	completionId: "completion-example-0001",
	revision: 1,
	text: "First ",
	isFinal: false,
	speechEligible: false,
	presentationMode: "ordered_segments",
	presentationSegment: {
		id: "completion-example-0001:segment:0",
		index: 0,
		revision: 1,
		text: "First ",
		isFinal: false,
		startedAt: "2026-08-17T15:00:00.000Z",
	},
});
assert.equal(projection.end(assistantMessage([{ type: "text", text: "First " }])), null);

const beforeTool = projection.boundary({ durableMessageIds: ["entry-example-a"] });
assert.deepEqual(beforeTool?.presentationSegment, {
	id: "completion-example-0001:segment:0",
	index: 0,
	revision: 2,
	text: "First ",
	isFinal: true,
	startedAt: "2026-08-17T15:00:00.000Z",
	durableMessageIds: ["entry-example-a"],
});

assert.equal(projection.begin(assistantMessage([])), null);
const postToolPatch = projection.update(assistantMessage([
	{ type: "text", text: "answer." },
]), "text_delta");
assert.equal(postToolPatch?.text, "First answer.");
assert.equal(postToolPatch?.revision, 3);
assert.equal(postToolPatch?.isFinal, false);
assert.deepEqual(postToolPatch?.presentationSegment, {
	id: "completion-example-0001:segment:1",
	index: 1,
	revision: 1,
	text: "answer.",
	isFinal: false,
	startedAt: "2026-08-17T15:00:00.001Z",
});

const completed = projection.finalize({
	outcome: "completed",
	durableMessageIds: ["entry-example-a", "entry-example-b", "entry-example-b"],
	presentationDurableMessageIds: ["entry-example-b", "entry-example-b"],
});
assert.deepEqual(completed, {
	type: "assistant_text",
	completionId: "completion-example-0001",
	revision: 4,
	text: "First answer.",
	isFinal: true,
	outcome: "completed",
	speechEligible: true,
	durableMessageIds: ["entry-example-a", "entry-example-b"],
	presentationMode: "ordered_segments",
	presentationSegment: {
		id: "completion-example-0001:segment:1",
		index: 1,
		revision: 2,
		text: "answer.",
		isFinal: true,
		startedAt: "2026-08-17T15:00:00.001Z",
		durableMessageIds: ["entry-example-b"],
	},
});
assert.doesNotMatch(JSON.stringify(completed), /PRIVATE_REASONING|PRIVATE_ARGUMENT|example_tool/);

projection.reset("completion-example-0002");
projection.begin(assistantMessage([]));
projection.update(assistantMessage([{ type: "text", text: "Unfinished" }]), "text_delta");
const cancelled = projection.finalize({ outcome: "cancelled" });
assert.equal(cancelled.text, "Unfinished");
assert.equal(cancelled.isFinal, true);
assert.equal(cancelled.speechEligible, false);

projection.reset("completion-example-0003");
projection.begin(assistantMessage([]));
projection.update(assistantMessage([{ type: "text", text: "Partial before failure" }]), "text_delta");
const failed = projection.finalize({ outcome: "failed", durableMessageIds: ["entry-failed"] });
assert.equal(failed.text, "Partial before failure");
assert.equal(failed.isFinal, true);
assert.equal(failed.outcome, "failed");
assert.equal(failed.speechEligible, false, "late runtime failures never turn partial text into speech");

projection.reset("completion-example-backpressure");
projection.begin(assistantMessage([]));
assert.equal(
	projection.update(assistantMessage([{ type: "text", text: "First" }]), "text_delta")?.text,
	"First",
	"the first visible text paints immediately",
);
assert.equal(
	projection.update(assistantMessage([{ type: "text", text: "First tiny" }]), "text_delta"),
	null,
	"small append-only token bursts coalesce instead of doubling the legacy hot path",
);
assert.equal(
	projection.update(assistantMessage([{ type: "text", text: "First tiny cumulative patch after enough growth" }]), "text_delta")?.text,
	"First tiny cumulative patch after enough growth",
);
assert.equal(
	projection.update(assistantMessage([{ type: "text", text: "Revised answer" }]), "text_delta")?.text,
	"Revised answer",
	"a non-append rewrite is emitted immediately regardless of size",
);

const projected = projectRuntimeEventForTerminal({
	...completed,
	privatePayload: "PRIVATE_UNKNOWN_FIELD",
	presentationSegment: completed.presentationSegment
		? { ...completed.presentationSegment, privatePayload: "PRIVATE_SEGMENT_FIELD" }
		: undefined,
} as RuntimeAssistantTextEvent);
assert.deepEqual(projected, completed);
assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_UNKNOWN_FIELD|PRIVATE_SEGMENT_FIELD/);

const hub = new RuntimeLiveEventHub(8);
const metadata = {
	runId: "run-example-0001",
	channelId: "example-channel",
	source: "example-adapter",
};
hub.publishRuntime(metadata, firstPatch!);
hub.publishRuntime(metadata, beforeTool!);
hub.publishRuntime(metadata, {
	type: "toolCall",
	id: "tool-example",
	name: "example_tool",
	arguments: { secret: "PRIVATE_ARGUMENT" },
});
hub.publishRuntime(metadata, postToolPatch!);

const activeReplay: string[] = [];
const activeSubscription = hub.subscribe((event) => activeReplay.push(JSON.stringify(event)));
activeSubscription.unsubscribe();
assert.equal(activeReplay.length, 3, "reconnect replays each ordered prose segment and current tool state");
assert.match(activeReplay[0], /completion-example-0001:segment:0/);
assert.match(activeReplay[1], /tool-example/);
assert.match(activeReplay[2], /completion-example-0001:segment:1/);
assert.doesNotMatch(activeReplay.join("\n"), /PRIVATE_ARGUMENT/);

const cursorReplay: string[] = [];
const cursorSubscription = hub.subscribe((event) => cursorReplay.push(JSON.stringify(event)), 1);
cursorSubscription.unsubscribe();
assert.equal(cursorReplay.filter((event) => event.includes('"type":"assistant_text"')).length, 2);
assert.match(cursorReplay.join("\n"), /First answer\./);

projection.reset("completion-example-steer");
projection.begin(assistantMessage([]));
const proposal = projection.update(assistantMessage([{ type: "text", text: "First proposal." }]), "text_delta");
projection.end(assistantMessage([{ type: "text", text: "First proposal." }]));
const beforeSteer = projection.boundary({ durableMessageIds: ["entry-proposal"] });
projection.begin(assistantMessage([]));
const acknowledgment = projection.update(
	assistantMessage([{ type: "text", text: "Got it. Top-line only." }]),
	"text_delta",
);
assert.equal(proposal?.presentationSegment?.id, "completion-example-steer:segment:0");
assert.equal(beforeSteer?.presentationSegment?.isFinal, true);
assert.equal(acknowledgment?.presentationSegment?.id, "completion-example-steer:segment:1");
assert.equal(acknowledgment?.presentationSegment?.text, "Got it. Top-line only.");
assert.equal(
	acknowledgment?.text,
	"First proposal.Got it. Top-line only.",
	"the legacy run aggregate remains unchanged for completion and speech compatibility",
);
projection.end(assistantMessage([{ type: "text", text: "Got it. Top-line only." }]));
const beforeVisibleStatus = projection.boundary({ durableMessageIds: ["entry-acknowledgment"] });
projection.begin(assistantMessage([]));
const afterVisibleStatus = projection.update(
	assistantMessage([{ type: "text", text: "Recovered after status." }]),
	"text_delta",
);
assert.equal(beforeVisibleStatus?.presentationSegment?.isFinal, true);
assert.equal(afterVisibleStatus?.presentationSegment?.id, "completion-example-steer:segment:2");
assert.equal(afterVisibleStatus?.presentationSegment?.text, "Recovered after status.");

hub.publishRuntime(metadata, { type: "run_complete", channelId: "example-channel" });
const completedReplay: string[] = [];
const completedSubscription = hub.subscribe((event) => completedReplay.push(JSON.stringify(event)));
completedSubscription.unsubscribe();
assert.deepEqual(completedReplay, [], "completed runs are reconciled durably rather than replayed as active");

console.log("assistant text projection tests passed");

function assistantMessage(content: Array<Record<string, unknown>>): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "example-api",
		provider: "example-provider",
		model: "example-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
	} as AgentMessage;
}
