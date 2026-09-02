import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FollowUpWakeMetadata, MomEvent } from "../src/adapters/types.js";
import { attentionQueueDir } from "../src/attention/paths.js";
import { MomSettingsManager } from "../src/context.js";
import { parseEventContent } from "../src/events.js";
import { GOAL_CONTINUATION_SOURCE_EVENT } from "../src/goal-continuation.js";
import {
	armPendingFollowUps,
	cancelFollowUpSchedules,
	claimFollowUpWake,
	clearAllFollowUpSchedules,
	getFollowUpRuntimeStatus,
	isEligibleFollowUpWake,
	noteCompletedFollowUpWake,
	reconcileFollowUpSchedules,
} from "../src/follow-ups.js";

function event(ts: string, overrides: Partial<MomEvent> = {}): MomEvent {
	return {
		type: "mention",
		channel: "C0000000000",
		ts,
		user: "U0000000000",
		text: "Review the current open work.",
		directlyAddressed: true,
		threadTs: "1000000000.000001",
		replyTarget: "slack:C0000000000:1000000000.000001",
		replyTargetDescription: "Synthetic Slack thread",
		...overrides,
	};
}

function queueFiles(workingDir: string): string[] {
	const queueDir = attentionQueueDir(workingDir);
	if (!existsSync(queueDir)) return [];
	return readdirSync(queueDir).filter((filename) => filename.startsWith("follow-up-") && filename.endsWith(".json")).sort();
}

function readQueueEvent(workingDir: string, filename: string): any {
	return JSON.parse(readFileSync(join(attentionQueueDir(workingDir), filename), "utf-8"));
}

const workingDir = mkdtempSync(join(tmpdir(), "follow-ups-"));
try {
	const defaults = new MomSettingsManager(workingDir).getFollowUpSettings();
	assert.equal(defaults.enabled, false, "existing workspaces remain opt-in when followUps is absent");
	assert.deepEqual(defaults.intervalsMinutes, [1, 3, 5, 10]);
	assert.equal(noteCompletedFollowUpWake(workingDir, event("1")).eligible, false);

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({ followUps: "default" }), "utf-8");
	const preset = new MomSettingsManager(workingDir).getFollowUpSettings();
	assert.deepEqual(preset, { enabled: true, preset: "default", intervalsMinutes: [1, 3, 5, 10] });

	assert.equal(isEligibleFollowUpWake(event("2", { directlyAddressed: false })), true, "ambient canonical wakes can reset the global schedule");
	assert.equal(isEligibleFollowUpWake(event("3", { user: "EVENT", channel: "heartbeat" })), true, "scheduled and heartbeat wakes can reset the global schedule");
	assert.equal(isEligibleFollowUpWake(event("4", { user: "U1111111111" })), true, "authorized agent-authored wakes are not downgraded");
	for (const [transport, sourceEventType] of [
		["Slack", "slack_dm"],
		["Zulip", "zulip_dm"],
		["web/terminal", "terminal_tui"],
		["voice", "realtime_voice"],
	] as const) {
		assert.equal(
			isEligibleFollowUpWake(event(`transport-${transport}`, { sourceEventType })),
			true,
			`${transport} is eligible after the same canonical completion boundary`,
		);
	}
	assert.equal(isEligibleFollowUpWake(event("operator")), true, "canonical operator instructions are not blanket-excluded");
	assert.equal(isEligibleFollowUpWake(event("slash", { text: "/status" })), true, "a slash-looking event is eligible if it reached canonical completion");
	assert.equal(isEligibleFollowUpWake(event("follow-up", { user: "EVENT", sourceEventType: "follow_up" })), false, "generated checkpoints never recurse");
	assert.equal(
		isEligibleFollowUpWake(event("goal", { user: "goal", sourceEventType: GOAL_CONTINUATION_SOURCE_EVENT })),
		false,
		"internal automatic goal continuations do not replace a user wake anchor",
	);

	const hostSource = readFileSync("src/host/node/cli.ts", "utf-8");
	assert.equal(
		(hostSource.match(/noteCompletedFollowUpWake\(/g) ?? []).length,
		1,
		"the host records checkpoint activity only at the canonical completion boundary",
	);
	assert.match(
		hostSource,
		/if \(completedCanonicalTurn\) \{\s*noteCompletedFollowUpWake\(workingDir, event\);\s*\}/,
		"only a completed canonical wake can replace the global schedule without consulting its transport",
	);
	assert.doesNotMatch(hostSource, /noteFollowUpActivity/, "inbound receipt and steering no longer move the checkpoint anchor");

	const first = noteCompletedFollowUpWake(workingDir, event("1000000000.000001"), new Date("2040-01-01T23:20:00.000Z"));
	assert.equal(first.eligible, true);
	assert.equal(first.key, "agent-global");
	assert.ok(first.generation);
	assert.equal(getFollowUpRuntimeStatus(workingDir).state, "pending");
	assert.equal(armPendingFollowUps(workingDir, new Date("2040-01-01T23:21:00.000Z")), 1);
	const armedStatus = getFollowUpRuntimeStatus(workingDir);
	assert.equal(armedStatus.state, "scheduled");
	assert.equal(armedStatus.pendingSequences, 0);
	assert.equal(armedStatus.scheduledWakes, 4);
	assert.equal(armedStatus.claimedWakes, 0);
	assert.equal(armedStatus.nextWakeAt, "2040-01-01T23:22:00.000Z");

	const stateFiles = readdirSync(join(workingDir, "attention", "follow-ups"));
	assert.deepEqual(stateFiles, ["agent-global.json"], "exactly one agent-global state file exists");
	const serializedState = readFileSync(join(workingDir, "attention", "follow-ups", "agent-global.json"), "utf-8");
	assert.doesNotMatch(serializedState, /replyTarget|threadTs|channelId|target/, "global state retains no delivery target");

	const firstFiles = queueFiles(workingDir);
	assert.equal(firstFiles.length, 4, "the default preset creates one finite four-checkpoint chain");
	const firstEvents = firstFiles.map((filename) => readQueueEvent(workingDir, filename));
	assert.deepEqual(firstEvents.map((entry) => entry.at), [
		"2040-01-01T23:22:00.000Z",
		"2040-01-01T23:24:00.000Z",
		"2040-01-01T23:26:00.000Z",
		"2040-01-01T23:31:00.000Z",
	]);
	assert.ok(firstEvents.every((entry) => entry.channelId === "follow-up"));
	assert.ok(firstEvents.every((entry) => entry.sourceEventType === "follow_up"));
	assert.ok(firstEvents.every((entry) => entry.replyTarget === undefined && entry.threadTs === undefined), "checkpoint events inherit no conversation");
	assert.ok(firstEvents.every((entry) => entry.text.includes("agent-global internal checkpoint")));
	assert.ok(firstEvents.every((entry) => !entry.text.includes("slack:C0000000000")), "checkpoint prompts do not leak the prior target");
	const parsedFirst = parseEventContent(JSON.stringify(firstEvents[0]));
	assert.equal(parsedFirst?.channelId, "follow-up");
	assert.equal(parsedFirst?.replyTarget, undefined);
	assert.deepEqual(parsedFirst?.followUp, firstEvents[0].followUp, "scheduled parsing preserves the global generation claim");

	const firstWake = firstEvents[0].followUp as FollowUpWakeMetadata;
	assert.equal(claimFollowUpWake(workingDir, firstWake, new Date("2040-01-01T23:22:00.000Z")), true);
	assert.equal(claimFollowUpWake(workingDir, firstWake, new Date("2040-01-01T23:22:01.000Z")), false, "a claimed wake cannot replay");
	assert.equal(getFollowUpRuntimeStatus(workingDir).claimedWakes, 1, "runtime status exposes durable claims");
	const finiteCount = queueFiles(workingDir).length;
	assert.equal(
		noteCompletedFollowUpWake(workingDir, event("follow-up", { user: "EVENT", sourceEventType: "follow_up", followUp: firstWake })).eligible,
		false,
		"a completed generated checkpoint does not replace the sequence",
	);
	assert.equal(armPendingFollowUps(workingDir), 0, "a generated checkpoint does not create a pending sequence");
	assert.equal(queueFiles(workingDir).length, finiteCount, "the finite chain remains bounded after a generated checkpoint");

	const oldSecondWake = firstEvents[1].followUp as FollowUpWakeMetadata;
	const second = noteCompletedFollowUpWake(workingDir, event("2000000000.000001", {
		channel: "C1111111111",
		threadTs: "2000000000.000001",
		replyTarget: "slack:C1111111111:2000000000.000001",
		directlyAddressed: false,
		user: "U1111111111",
	}), new Date("2040-01-01T23:22:30.000Z"));
	assert.equal(second.eligible, true);
	assert.notEqual(second.generation, first.generation, "the latest eligible wake replaces the global generation");
	assert.equal(queueFiles(workingDir).length, 0, "a later wake cancels the prior global queue before rearming");
	assert.equal(claimFollowUpWake(workingDir, oldSecondWake), false, "stale generations fail closed across conversations");
	assert.equal(getFollowUpRuntimeStatus(workingDir).pendingSequences, 1, "only one global sequence can be pending");

	assert.equal(armPendingFollowUps(workingDir, new Date("2040-01-01T23:23:00.000Z")), 1);
	const replacementFiles = queueFiles(workingDir);
	assert.equal(replacementFiles.length, 4);
	const replacementEvents = replacementFiles.map((filename) => readQueueEvent(workingDir, filename));
	assert.ok(replacementEvents.every((entry) => entry.replyTarget === undefined), "the replacement still carries no latest-wake target");
	assert.equal(
		noteCompletedFollowUpWake(workingDir, event("goal-control", { user: "goal", sourceEventType: GOAL_CONTINUATION_SOURCE_EVENT })).eligible,
		false,
	);
	assert.deepEqual(queueFiles(workingDir), replacementFiles, "an internal continuation leaves the eligible schedule unchanged");

	const removed = replacementFiles[1];
	unlinkSync(join(attentionQueueDir(workingDir), removed));
	assert.equal(
		reconcileFollowUpSchedules(workingDir, new Date("2040-01-01T23:23:01.000Z")),
		1,
		"restart reconciliation restores a missing scheduled checkpoint",
	);
	assert.ok(existsSync(join(attentionQueueDir(workingDir), removed)));

	const claimedReplacement = replacementEvents[0].followUp as FollowUpWakeMetadata;
	assert.equal(claimFollowUpWake(workingDir, claimedReplacement, new Date("2040-01-01T23:24:00.000Z")), true);
	unlinkSync(join(attentionQueueDir(workingDir), replacementFiles[0]));
	assert.equal(
		reconcileFollowUpSchedules(workingDir, new Date("2050-01-01T00:00:00.000Z")),
		3,
		"long downtime rearms every unclaimed checkpoint",
	);
	assert.equal(existsSync(join(attentionQueueDir(workingDir), replacementFiles[0])), false, "claimed checkpoints are never recreated");
	const lateStatus = getFollowUpRuntimeStatus(workingDir);
	assert.equal(lateStatus.claimedWakes, 1);
	assert.equal(lateStatus.scheduledWakes, 3);
	assert.equal(lateStatus.nextWakeAt, "2050-01-01T00:00:30.000Z");

	const cancelled = cancelFollowUpSchedules(workingDir);
	assert.equal(cancelled.claimedWakes, 1);
	assert.equal(cancelled.scheduledWakes, 3);
	const afterCancel = getFollowUpRuntimeStatus(workingDir);
	assert.equal(afterCancel.enabled, true, "explicit cancellation preserves enabled configuration");
	assert.equal(afterCancel.state, "idle");
	assert.equal(afterCancel.scheduledWakes, 0);
	assert.equal(afterCancel.claimedWakes, 0);

	const legacyStateDir = join(workingDir, "attention", "follow-ups");
	mkdirSync(legacyStateDir, { recursive: true });
	writeFileSync(join(legacyStateDir, "legacy-conversation.json"), JSON.stringify({
		version: 1,
		key: "legacy-conversation",
		generation: "legacy-generation",
		status: "armed",
		target: { replyTarget: "slack:C2222222222:3000000000.000001" },
		wakes: [],
	}), "utf-8");
	mkdirSync(attentionQueueDir(workingDir), { recursive: true });
	writeFileSync(join(attentionQueueDir(workingDir), "follow-up-legacy-conversation.json"), "{}", "utf-8");
	assert.equal(reconcileFollowUpSchedules(workingDir), 0);
	assert.equal(existsSync(join(legacyStateDir, "legacy-conversation.json")), false, "legacy per-conversation state is discarded");
	assert.equal(queueFiles(workingDir).length, 0, "legacy target-bearing queue files are discarded");

	clearAllFollowUpSchedules(workingDir);
	assert.equal(queueFiles(workingDir).length, 0);
	assert.equal(existsSync(join(workingDir, "attention", "follow-ups")), false);
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("follow-ups tests passed");
