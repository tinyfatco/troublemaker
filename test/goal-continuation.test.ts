import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { MomContext, MomEvent } from "../src/adapters/types.js";
import {
	applyGoalContinuationIdentity,
	buildGoalContinuationPrompt,
	createGoalContinuationEvent,
	decideGoalContinuation,
	GOAL_CONTINUATION_SOURCE_EVENT,
} from "../src/goal-continuation.js";
import type { GoalState } from "../src/goal-state.js";

const activeGoal: GoalState = {
	goal: "Finish the durable objective",
	setAt: "2026-07-15T00:00:00.000Z",
	status: "active",
};

const baseDecision = {
	goal: activeGoal,
	stopReason: "stop",
	stopRequested: false,
	interruptRequested: false,
	runtimeRunning: true,
	queuedRuns: 0,
};

assert.equal(decideGoalContinuation(baseDecision), "continue");
assert.equal(decideGoalContinuation({ ...baseDecision, queuedRuns: 1 }), "stop", "queued user/client work wins");
assert.equal(decideGoalContinuation({ ...baseDecision, interruptRequested: true }), "stop");
assert.equal(decideGoalContinuation({ ...baseDecision, stopRequested: true }), "stop");
assert.equal(decideGoalContinuation({ ...baseDecision, stopReason: "aborted" }), "stop");
assert.equal(decideGoalContinuation({ ...baseDecision, stopReason: "error" }), "block");
assert.equal(decideGoalContinuation({ ...baseDecision, goal: { ...activeGoal, status: "blocked" } }), "stop");
assert.equal(decideGoalContinuation({ ...baseDecision, goal: null }), "stop");

const baseEvent: MomEvent = {
	type: "dm",
	channel: "CEXAMPLE",
	ts: "100.200",
	user: "U_EXAMPLE",
	text: "original request",
	rawText: "original request",
	freshContext: true,
	directlyAddressed: true,
	threadTs: "100.200",
	replyTarget: "slack:CEXAMPLE:100.200",
	files: [{ name: "source.txt", url_private: "https://example.com/source.txt" }],
	attachments: [{ local: "attachments/source.txt" }],
};
const continuation = createGoalContinuationEvent(baseEvent, 2);
assert.equal(continuation.channel, baseEvent.channel);
assert.equal(continuation.threadTs, baseEvent.threadTs);
assert.equal(continuation.replyTarget, baseEvent.replyTarget);
assert.equal(continuation.directlyAddressed, true);
assert.equal(continuation.sourceEventType, GOAL_CONTINUATION_SOURCE_EVENT);
assert.equal(continuation.freshContext, false);
assert.deepEqual(continuation.files, []);
assert.deepEqual(continuation.attachments, []);
assert.match(continuation.text, /not a new user message/);
assert.match(continuation.text, /Automatic goal turn: 2/);
assert.doesNotMatch(continuation.text, /Finish the durable objective/, "fresh goal state comes from the turn preamble");
assert.match(buildGoalContinuationPrompt(1, true), /runtime restarted/);

const ctx = {
	message: {
		text: continuation.text,
		rawText: continuation.text,
		user: baseEvent.user,
		userName: "Example User",
		channel: baseEvent.channel,
		ts: baseEvent.ts,
		attachments: [{ local: "attachments/source.txt" }],
	},
} as unknown as MomContext;
applyGoalContinuationIdentity(ctx);
assert.equal(ctx.message.user, "goal");
assert.equal(ctx.message.userName, "goal");
assert.equal(ctx.message.sourceEventType, GOAL_CONTINUATION_SOURCE_EVENT);
assert.deepEqual(ctx.message.attachments, []);

const cliSource = await readFile(new URL("../src/host/node/cli.ts", import.meta.url), "utf8");
assert.match(cliSource, /decideGoalContinuation\(\{/);
assert.match(cliSource, /queuedRuns: queuedRunCount/);
assert.match(cliSource, /createGoalContinuationEvent\(event, automaticGoalTurn\)/);
assert.match(cliSource, /enqueueActiveGoalContinuationWake\(true\)/, "active goals resume after runtime startup");
assert.match(
	cliSource,
	/state\.runner\.run\(\s*ctx,\s*state\.store,\s*undefined,\s*platform\.formatInstructions,\s*\(runtimeEvent\) => \{ gateway\.publishRuntimeEvent\(liveMetadata, runtimeEvent\); \},\s*\)/,
	"goal continuations use the normal runner path and unified live-event sink",
);

console.log("goal continuation: ok");
