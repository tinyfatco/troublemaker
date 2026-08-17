import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RuntimeAssistantTextEvent } from "../src/core/runtime-contract.js";
import { RuntimeLiveEventHub, projectRuntimeEventForTerminal } from "../src/live-events.js";
import { AssistantTextProjection } from "../src/streaming/assistant-text-projection.js";

const projection = new AssistantTextProjection();
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
});
assert.equal(projection.end(assistantMessage([{ type: "text", text: "First " }])), null);

assert.equal(projection.begin(assistantMessage([])), null);
const postToolPatch = projection.update(assistantMessage([
	{ type: "text", text: "answer." },
]), "text_delta");
assert.equal(postToolPatch?.text, "First answer.");
assert.equal(postToolPatch?.revision, 2);
assert.equal(postToolPatch?.isFinal, false);

const completed = projection.finalize({
	outcome: "completed",
	durableMessageIds: ["entry-example-a", "entry-example-b", "entry-example-b"],
});
assert.deepEqual(completed, {
	type: "assistant_text",
	completionId: "completion-example-0001",
	revision: 3,
	text: "First answer.",
	isFinal: true,
	outcome: "completed",
	speechEligible: true,
	durableMessageIds: ["entry-example-a", "entry-example-b"],
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
} as RuntimeAssistantTextEvent);
assert.deepEqual(projected, completed);
assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_UNKNOWN_FIELD/);

const hub = new RuntimeLiveEventHub(8);
const metadata = {
	runId: "run-example-0001",
	channelId: "example-channel",
	source: "example-adapter",
};
hub.publishRuntime(metadata, firstPatch!);
hub.publishRuntime(metadata, postToolPatch!);
hub.publishRuntime(metadata, {
	type: "toolCall",
	id: "tool-example",
	name: "example_tool",
	arguments: { secret: "PRIVATE_ARGUMENT" },
});

const activeReplay: string[] = [];
const activeSubscription = hub.subscribe((event) => activeReplay.push(JSON.stringify(event)));
activeSubscription.unsubscribe();
assert.equal(activeReplay.length, 2, "reconnect replays the latest cumulative prose and current run state");
assert.match(activeReplay[0], /First answer\./);
assert.doesNotMatch(activeReplay.join("\n"), /PRIVATE_ARGUMENT/);

const cursorReplay: string[] = [];
const cursorSubscription = hub.subscribe((event) => cursorReplay.push(JSON.stringify(event)), 1);
cursorSubscription.unsubscribe();
assert.equal(cursorReplay.filter((event) => event.includes('"type":"assistant_text"')).length, 1);
assert.match(cursorReplay.join("\n"), /First answer\./);

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
