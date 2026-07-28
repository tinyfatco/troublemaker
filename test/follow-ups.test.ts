import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FollowUpWakeMetadata, MomEvent } from "../src/adapters/types.js";
import { attentionQueueDir } from "../src/attention/paths.js";
import { MomSettingsManager } from "../src/context.js";
import { parseEventContent } from "../src/events.js";
import {
	armPendingFollowUps,
	cancelFollowUpSchedules,
	claimFollowUpWake,
	clearAllFollowUpSchedules,
	getFollowUpRuntimeStatus,
	isEligibleFollowUpActivity,
	noteFollowUpActivity,
	reconcileFollowUpSchedules,
} from "../src/follow-ups.js";

function event(ts: string, overrides: Partial<MomEvent> = {}): MomEvent {
	return {
		type: "mention",
		channel: "C0000000000",
		ts,
		user: "U0000000000",
		text: "Can you follow up if I go quiet?",
		directlyAddressed: true,
		threadTs: "1000000000.000001",
		replyTarget: "slack:C0000000000:1000000000.000001",
		replyTargetDescription: "Slack thread under the human request",
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
	assert.equal(noteFollowUpActivity(workingDir, event("1"), "slack").eligible, false);

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({ followUps: "default" }), "utf-8");
	const preset = new MomSettingsManager(workingDir).getFollowUpSettings();
	assert.deepEqual(preset, { enabled: true, preset: "default", intervalsMinutes: [1, 3, 5, 10] });

	const first = noteFollowUpActivity(workingDir, event("1000000000.000001"), "slack", new Date("2040-01-01T23:20:00.000Z"));
	assert.equal(first.eligible, true);
	assert.ok(first.key && first.generation);
	assert.equal(getFollowUpRuntimeStatus(workingDir).state, "pending");
	assert.equal(armPendingFollowUps(workingDir, new Date("2040-01-01T23:21:00.000Z")), 1);
	const armedStatus = getFollowUpRuntimeStatus(workingDir);
	assert.equal(armedStatus.state, "scheduled");
	assert.equal(armedStatus.scheduledWakes, 4);
	assert.equal(armedStatus.claimedWakes, 0);
	assert.equal(armedStatus.nextWakeAt, "2040-01-01T23:22:00.000Z");
	const firstFiles = queueFiles(workingDir);
	assert.equal(firstFiles.length, 4, "default preset creates a finite four-checkpoint chain");
	const firstEvents = firstFiles.map((filename) => readQueueEvent(workingDir, filename));
	assert.deepEqual(firstEvents.map((entry) => entry.at), [
		"2040-01-01T23:22:00.000Z",
		"2040-01-01T23:24:00.000Z",
		"2040-01-01T23:26:00.000Z",
		"2040-01-01T23:31:00.000Z",
	]);
	assert.ok(firstEvents.every((entry) => entry.replyTarget === "slack:C0000000000:1000000000.000001"));
	assert.ok(firstEvents.every((entry) => entry.sourceEventType === "follow_up"));
	const parsedFirst = parseEventContent(JSON.stringify(firstEvents[0]));
	assert.equal(parsedFirst?.sourceEventType, "follow_up", "scheduled parsing preserves the wake classification");
	assert.deepEqual(parsedFirst?.followUp, firstEvents[0].followUp, "scheduled parsing preserves the generation claim");
	assert.equal(parsedFirst?.replyTarget, "slack:C0000000000:1000000000.000001", "scheduled parsing preserves the exact reply target");

	const firstWake = firstEvents[0].followUp as FollowUpWakeMetadata;
	assert.equal(claimFollowUpWake(workingDir, firstWake, new Date("2040-01-01T23:22:00.000Z")), true);
	assert.equal(claimFollowUpWake(workingDir, firstWake, new Date("2040-01-01T23:22:01.000Z")), false, "a claimed wake cannot replay");
	assert.equal(getFollowUpRuntimeStatus(workingDir).claimedWakes, 1, "runtime status exposes durable claims");
	const finiteCount = queueFiles(workingDir).length;
	assert.equal(armPendingFollowUps(workingDir), 0, "a follow-up wake does not recursively arm another sequence");
	assert.equal(queueFiles(workingDir).length, finiteCount, "the finite chain remains bounded after a wake claim");

	const oldSecondWake = firstEvents[1].followUp as FollowUpWakeMetadata;
	const second = noteFollowUpActivity(workingDir, event("1000000001.000001"), "slack", new Date("2040-01-01T23:22:30.000Z"));
	assert.equal(second.eligible, true);
	assert.notEqual(second.generation, first.generation, "new human activity replaces the generation immediately");
	assert.equal(queueFiles(workingDir).length, 0, "new activity cancels the old queue before the next turn finishes");
	assert.equal(claimFollowUpWake(workingDir, oldSecondWake), false, "already-enqueued stale generations fail closed");

	assert.equal(armPendingFollowUps(workingDir, new Date("2040-01-01T23:23:00.000Z")), 1);
	const replacementFiles = queueFiles(workingDir);
	assert.equal(replacementFiles.length, 4);
	const removed = replacementFiles[1];
	unlinkSync(join(attentionQueueDir(workingDir), removed));
	assert.equal(
		reconcileFollowUpSchedules(workingDir, new Date("2040-01-01T23:23:01.000Z")),
		1,
		"restart reconciliation restores a missing scheduled wake",
	);
	assert.ok(existsSync(join(attentionQueueDir(workingDir), removed)));

	const replacementEvents = replacementFiles.map((filename) => readQueueEvent(workingDir, filename));
	const claimedReplacement = replacementEvents[0].followUp as FollowUpWakeMetadata;
	assert.equal(claimFollowUpWake(workingDir, claimedReplacement, new Date("2040-01-01T23:24:00.000Z")), true);
	unlinkSync(join(attentionQueueDir(workingDir), replacementFiles[0]));
	assert.equal(
		reconcileFollowUpSchedules(workingDir, new Date("2050-01-01T00:00:00.000Z")),
		3,
		"downtime longer than the watcher grace window rearms every unclaimed wake",
	);
	assert.equal(existsSync(join(attentionQueueDir(workingDir), replacementFiles[0])), false, "claimed wakes are never recreated");
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

	const ambient = event("1000000002.000001", { directlyAddressed: false });
	assert.equal(isEligibleFollowUpActivity(ambient, "slack"), false, "ambient traffic does not create follow-up sequences");
	assert.equal(noteFollowUpActivity(workingDir, ambient, "slack").eligible, false);
	assert.equal(isEligibleFollowUpActivity(event("2", { user: "EVENT", sourceEventType: "follow_up" }), "slack"), false);
	assert.equal(isEligibleFollowUpActivity(event("3", { text: "/model list" }), "slack"), false);
	assert.equal(isEligibleFollowUpActivity(event("4"), "web"), false, "ephemeral web sessions are excluded");

	clearAllFollowUpSchedules(workingDir);
	assert.equal(queueFiles(workingDir).length, 0);
	assert.equal(existsSync(join(workingDir, "attention", "follow-ups")), false);
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("follow-ups tests passed");
