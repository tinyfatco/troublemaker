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
	claimFollowUpWake,
	clearAllFollowUpSchedules,
	isEligibleFollowUpActivity,
	noteFollowUpActivity,
	reconcileFollowUpSchedules,
} from "../src/follow-ups.js";

function event(ts: string, overrides: Partial<MomEvent> = {}): MomEvent {
	return {
		type: "mention",
		channel: "C0123456789",
		ts,
		user: "U0123456789",
		text: "Can you follow up if I go quiet?",
		directlyAddressed: true,
		threadTs: "1785194448.101469",
		replyTarget: "slack:C0123456789:1785194448.101469",
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

	const first = noteFollowUpActivity(workingDir, event("1785194448.101469"), "slack", new Date("2026-07-27T23:20:00.000Z"));
	assert.equal(first.eligible, true);
	assert.ok(first.key && first.generation);
	assert.equal(armPendingFollowUps(workingDir, new Date("2026-07-27T23:21:00.000Z")), 1);
	const firstFiles = queueFiles(workingDir);
	assert.equal(firstFiles.length, 4, "default preset creates a finite four-checkpoint chain");
	const firstEvents = firstFiles.map((filename) => readQueueEvent(workingDir, filename));
	assert.deepEqual(firstEvents.map((entry) => entry.at), [
		"2026-07-27T23:22:00.000Z",
		"2026-07-27T23:24:00.000Z",
		"2026-07-27T23:26:00.000Z",
		"2026-07-27T23:31:00.000Z",
	]);
	assert.ok(firstEvents.every((entry) => entry.replyTarget === "slack:C0123456789:1785194448.101469"));
	assert.ok(firstEvents.every((entry) => entry.sourceEventType === "follow_up"));
	assert.ok(firstEvents.every((entry) => !/pedicab|dispatch/i.test(entry.text)), "follow-up prompts remain business-neutral");
	const parsedFirst = parseEventContent(JSON.stringify(firstEvents[0]));
	assert.equal(parsedFirst?.sourceEventType, "follow_up", "scheduled parsing preserves the wake classification");
	assert.deepEqual(parsedFirst?.followUp, firstEvents[0].followUp, "scheduled parsing preserves the generation claim");
	assert.equal(parsedFirst?.replyTarget, "slack:C0123456789:1785194448.101469", "scheduled parsing preserves the exact reply target");

	const firstWake = firstEvents[0].followUp as FollowUpWakeMetadata;
	assert.equal(claimFollowUpWake(workingDir, firstWake, new Date("2026-07-27T23:22:00.000Z")), true);
	assert.equal(claimFollowUpWake(workingDir, firstWake, new Date("2026-07-27T23:22:01.000Z")), false, "a claimed wake cannot replay");
	const finiteCount = queueFiles(workingDir).length;
	assert.equal(armPendingFollowUps(workingDir), 0, "a follow-up wake does not recursively arm another sequence");
	assert.equal(queueFiles(workingDir).length, finiteCount, "the finite chain remains bounded after a wake claim");

	const oldSecondWake = firstEvents[1].followUp as FollowUpWakeMetadata;
	const second = noteFollowUpActivity(workingDir, event("1785194500.000000"), "slack", new Date("2026-07-27T23:22:30.000Z"));
	assert.equal(second.eligible, true);
	assert.notEqual(second.generation, first.generation, "new human activity replaces the generation immediately");
	assert.equal(queueFiles(workingDir).length, 0, "new activity cancels the old queue before the next turn finishes");
	assert.equal(claimFollowUpWake(workingDir, oldSecondWake), false, "already-enqueued stale generations fail closed");

	assert.equal(armPendingFollowUps(workingDir, new Date("2026-07-27T23:23:00.000Z")), 1);
	const replacementFiles = queueFiles(workingDir);
	assert.equal(replacementFiles.length, 4);
	const removed = replacementFiles[1];
	unlinkSync(join(attentionQueueDir(workingDir), removed));
	assert.equal(reconcileFollowUpSchedules(workingDir), 1, "restart reconciliation restores a missing scheduled wake");
	assert.ok(existsSync(join(attentionQueueDir(workingDir), removed)));

	const ambient = event("1785194600.000000", { directlyAddressed: false });
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
