import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MomEvent } from "../src/adapters/types.js";
import {
	DEFAULT_FOLLOW_UP_OFFSETS_MINUTES,
	PostRunFollowUpScheduler,
	normalizeFollowUpOffsets,
	shouldSchedulePostRunFollowUps,
} from "../src/attention/post-run-follow-up.js";
import { MomSettingsManager } from "../src/context.js";
import { parseEventContent } from "../src/events.js";
import { applySelfConfiguration } from "../src/tools/self-configure.js";

function managedQueueFiles(workingDir: string): string[] {
	const queueDir = join(workingDir, "attention", "queue");
	if (!existsSync(queueDir)) return [];
	return readdirSync(queueDir)
		.filter((filename) => filename.startsWith("post-run-follow-up-") && filename.endsWith(".json"))
		.sort();
}

function readQueueEvent(workingDir: string, filename: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(workingDir, "attention", "queue", filename), "utf-8"));
}

function deterministicIds(prefix: string): () => string {
	let next = 0;
	return () => `${prefix}-${++next}`;
}

const ordinaryEvent: MomEvent = {
	type: "dm",
	channel: "example-channel",
	ts: "1000.000001",
	user: "example-user",
	text: "Please review the latest draft.",
	directlyAddressed: true,
};

const root = mkdtempSync(join(tmpdir(), "post-run-follow-up-"));
try {
	// Disabled/default schedule.
	const defaultsDir = join(root, "defaults");
	const defaultSettings = new MomSettingsManager(defaultsDir).getFollowUpSettings();
	assert.equal(defaultSettings.enabled, false);
	assert.deepEqual(defaultSettings.offsetsMinutes, [...DEFAULT_FOLLOW_UP_OFFSETS_MINUTES]);
	const disabled = new PostRunFollowUpScheduler(defaultsDir, () => new Date("2030-01-01T00:00:00.000Z"), deterministicIds("default"));
	assert.equal(disabled.scheduleFromRunStop(defaultSettings).pending, 0);
	assert.deepEqual(managedQueueFiles(defaultsDir), []);

	// Enabling without custom offsets uses the finite default sequence.
	const enabledResult = applySelfConfiguration(defaultsDir, "follow_up.enabled", true);
	assert.equal(enabledResult.newValue, true);
	const enabledSettings = new MomSettingsManager(defaultsDir).getFollowUpSettings();
	const enabled = new PostRunFollowUpScheduler(defaultsDir, () => new Date("2030-01-01T00:00:00.000Z"), deterministicIds("enabled"));
	const defaultSequence = enabled.scheduleFromRunStop(enabledSettings);
	assert.equal(defaultSequence.pending, 4);
	assert.deepEqual(defaultSequence.offsetsMinutes, [1, 3, 5, 10]);
	const defaultEvents = managedQueueFiles(defaultsDir).map((filename) => readQueueEvent(defaultsDir, filename));
	assert.deepEqual(defaultEvents.map((event) => event.at), [
		"2030-01-01T00:01:00.000Z",
		"2030-01-01T00:03:00.000Z",
		"2030-01-01T00:05:00.000Z",
		"2030-01-01T00:10:00.000Z",
	]);
	for (const event of defaultEvents) {
		assert.equal(event.type, "one-shot");
		assert.equal(event.channelId, "follow-up");
		assert.match(String(event.sourceEventType), /^post_run_follow_up:/);
		assert.equal(parseEventContent(JSON.stringify(event))?.sourceEventType, event.sourceEventType);
		assert.match(String(event.text), /yield_no_action/);
		assert.match(String(event.text), /not a heartbeat/);
		assert.match(String(event.text), /not a promise/);
	}

	// Custom schedule validation and persistence.
	const custom = applySelfConfiguration(defaultsDir, "followUp.offsetsMinutes", "2m, 7m, 12m");
	assert.deepEqual(custom.newValue, [2, 7, 12]);
	assert.deepEqual(new MomSettingsManager(defaultsDir).getFollowUpSettings().offsetsMinutes, [2, 7, 12]);
	assert.deepEqual(managedQueueFiles(defaultsDir), [], "reconfiguration cancels the prior pending sequence");
	assert.throws(() => normalizeFollowUpOffsets([3, 3]), /strictly increasing/);
	assert.throws(() => normalizeFollowUpOffsets([5, 2]), /strictly increasing/);
	assert.throws(() => normalizeFollowUpOffsets([0]), /between 1/);
	assert.throws(() => applySelfConfiguration(defaultsDir, "follow_up.offsets", "1m, later"), /Invalid follow-up offset/);
	writeFileSync(join(defaultsDir, "settings.json"), JSON.stringify({ followUp: { enabled: true, offsetsMinutes: [5, 2] } }));
	assert.equal(new MomSettingsManager(defaultsDir).getFollowUpSettings().enabled, false, "invalid manual settings fail closed");

	// Restart recovery recreates a missing pending queue file from durable state.
	const recoveryDir = join(root, "recovery");
	const recoverySettings = new MomSettingsManager(recoveryDir).setFollowUp({ enabled: true, offsetsMinutes: [2, 4] });
	const firstProcess = new PostRunFollowUpScheduler(recoveryDir, () => new Date("2030-02-01T00:00:00.000Z"), deterministicIds("first"));
	firstProcess.scheduleFromRunStop(recoverySettings);
	const beforeRestart = managedQueueFiles(recoveryDir);
	assert.equal(beforeRestart.length, 2);
	unlinkSync(join(recoveryDir, "attention", "queue", beforeRestart[0]));
	const restarted = new PostRunFollowUpScheduler(recoveryDir, () => new Date("2030-02-01T00:10:00.000Z"), deterministicIds("restart"));
	const recovered = restarted.reconcileConfiguration(recoverySettings);
	assert.equal(recovered.pending, 2);
	assert.equal(recovered.nextWake, "2030-02-01T00:10:01.000Z", "overdue pending wakes are rearmed after restart");
	assert.deepEqual(managedQueueFiles(recoveryDir), beforeRestart);
	assert.equal(readQueueEvent(recoveryDir, beforeRestart[0]).at, "2030-02-01T00:10:01.000Z");

	// Durable claims are idempotent across duplicate delivery and restart.
	const firstWakeEvent = readQueueEvent(recoveryDir, beforeRestart[0]);
	const sourceEventType = String(firstWakeEvent.sourceEventType);
	const claim = restarted.claim(sourceEventType);
	assert(claim);
	assert.equal(restarted.claim(sourceEventType), null, "duplicate claim in the same process is rejected");
	const afterClaimRestart = new PostRunFollowUpScheduler(recoveryDir, () => new Date("2030-02-01T00:10:02.000Z"), deterministicIds("after-claim"));
	assert.equal(afterClaimRestart.claim(sourceEventType), null, "claimed wake is not executed again after restart");
	const completed = afterClaimRestart.complete(claim, "completed");
	assert.equal(completed.completed, 1);
	assert.equal(completed.pending, 1);

	// Supersession invalidates old wake identities and starts from the newest stop.
	const remainingOldEvent = readQueueEvent(recoveryDir, managedQueueFiles(recoveryDir)[0]);
	const oldSource = String(remainingOldEvent.sourceEventType);
	const cancelled = afterClaimRestart.cancelPending("new-user-work");
	assert.equal(cancelled.cancelled, 1);
	assert.deepEqual(managedQueueFiles(recoveryDir), []);
	const newest = afterClaimRestart.scheduleFromRunStop(recoverySettings);
	assert.equal(newest.pending, 2);
	assert.equal(afterClaimRestart.claim(oldSource), null, "superseded generation cannot execute");

	// Explicit cancellation preserves configuration; disabling cancels pending work.
	const cancelResult = applySelfConfiguration(recoveryDir, "follow_up.cancel", true);
	assert.equal((cancelResult.followUp as any).pending, 0);
	assert.equal(new MomSettingsManager(recoveryDir).getFollowUpSettings().enabled, true);
	afterClaimRestart.scheduleFromRunStop(recoverySettings);
	const disabledResult = applySelfConfiguration(recoveryDir, "follow_up.enabled", false);
	assert.equal(disabledResult.newValue, false);
	assert.equal((disabledResult.followUp as any).pending, 0);
	assert.deepEqual(managedQueueFiles(recoveryDir), []);

	// Only successful ordinary user runs seed a sequence; generated wakes cannot recurse.
	assert.equal(shouldSchedulePostRunFollowUps(ordinaryEvent, false, { stopReason: "stop" }), true);
	assert.equal(shouldSchedulePostRunFollowUps(ordinaryEvent, true, { stopReason: "stop" }), false);
	assert.equal(shouldSchedulePostRunFollowUps(ordinaryEvent, false, { stopReason: "error" }), false);
	assert.equal(shouldSchedulePostRunFollowUps({ ...ordinaryEvent, user: "EVENT" }, false, { stopReason: "stop" }), false);
	assert.equal(shouldSchedulePostRunFollowUps({
		...ordinaryEvent,
		user: "EVENT",
		sourceEventType: "post_run_follow_up:example-generation:example-wake",
	}, false, { stopReason: "stop" }), false);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("post-run follow-up tests passed");
