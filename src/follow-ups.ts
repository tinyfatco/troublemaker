import { createHash, randomUUID } from "crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { join } from "path";
import type { FollowUpWakeMetadata, MomEvent } from "./adapters/types.js";
import { attentionQueueDir } from "./attention/paths.js";
import { MomSettingsManager, type MomFollowUpSettings } from "./context.js";
import * as log from "./log.js";

const FOLLOW_UP_STATE_DIR = join("attention", "follow-ups");
const FOLLOW_UP_FILE_PREFIX = "follow-up-";
const RESTART_REARM_DELAY_MS = 30_000;

interface FollowUpTarget {
	adapter: string;
	channelId: string;
	replyTarget: string;
	replyTargetDescription?: string;
	threadTs?: string;
}

interface FollowUpWakeRecord extends FollowUpWakeMetadata {
	intervalMinutes: number;
	at: string;
	filename: string;
	status: "scheduled" | "claimed";
	claimedAt?: string;
}

interface FollowUpState {
	version: 1;
	key: string;
	generation: string;
	status: "pending" | "armed";
	lastActivityTs: string;
	notedAt: string;
	armedAt?: string;
	target: FollowUpTarget;
	wakes: FollowUpWakeRecord[];
}

export interface FollowUpActivityResult {
	eligible: boolean;
	key?: string;
	generation?: string;
}

export interface FollowUpRuntimeStatus {
	enabled: boolean;
	preset: MomFollowUpSettings["preset"];
	intervalsMinutes: number[];
	state: "disabled" | "idle" | "pending" | "scheduled" | "claimed";
	pendingSequences: number;
	scheduledWakes: number;
	claimedWakes: number;
	nextWakeAt: string | null;
}

function stateDir(workingDir: string): string {
	return join(workingDir, FOLLOW_UP_STATE_DIR);
}

function statePath(workingDir: string, key: string): string {
	return join(stateDir(workingDir), `${key}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	renameSync(temp, path);
}

function readState(path: string): FollowUpState | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as FollowUpState;
		if (parsed.version !== 1 || !parsed.key || !parsed.generation || !parsed.target?.replyTarget) return null;
		return parsed;
	} catch {
		return null;
	}
}

function listStates(workingDir: string): Array<{ path: string; state: FollowUpState }> {
	const dir = stateDir(workingDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((filename) => filename.endsWith(".json"))
		.map((filename) => ({ path: join(dir, filename), state: readState(join(dir, filename)) }))
		.filter((entry): entry is { path: string; state: FollowUpState } => entry.state !== null);
}

function targetKey(replyTarget: string): string {
	return createHash("sha256").update(replyTarget).digest("hex").slice(0, 20);
}

function deriveReplyTarget(event: MomEvent, adapter: string): string | null {
	if (event.replyTarget?.trim()) return event.replyTarget.trim();
	if (adapter === "slack") return event.threadTs
		? `slack:${event.channel}:${event.threadTs}`
		: `slack:${event.channel}`;
	if (adapter === "mattermost") return `mattermost:${event.channel}`;
	if (adapter === "rocket-chat") return `rocket-chat:${event.channel}`;
	if (adapter === "zulip") return `zulip:${event.channel}`;
	if (adapter === "discord") return `discord:${event.channel}`;
	if (adapter === "telegram" || adapter === "email" || adapter === "phone") return event.channel;
	return null;
}

export function isEligibleFollowUpActivity(event: MomEvent, adapter: string): boolean {
	if (event.followUp || event.sourceEventType === "follow_up") return false;
	if (event.user === "EVENT" || event.user === "goal" || event.channel === "heartbeat") return false;
	if (event.directlyAddressed === false) return false;
	if (event.text.trim().startsWith("/")) return false;
	if (["heartbeat", "operator", "form", "web", "voice"].includes(adapter)) return false;
	return deriveReplyTarget(event, adapter) !== null;
}

function clearQueueForKey(workingDir: string, key: string): void {
	const queueDir = attentionQueueDir(workingDir);
	if (!existsSync(queueDir)) return;
	const prefix = `${FOLLOW_UP_FILE_PREFIX}${key}-`;
	for (const filename of readdirSync(queueDir)) {
		if (!filename.startsWith(prefix) || !filename.endsWith(".json")) continue;
		try { unlinkSync(join(queueDir, filename)); } catch {}
	}
}

export function clearAllFollowUpSchedules(workingDir: string): void {
	const queueDir = attentionQueueDir(workingDir);
	if (existsSync(queueDir)) {
		for (const filename of readdirSync(queueDir)) {
			if (!filename.startsWith(FOLLOW_UP_FILE_PREFIX) || !filename.endsWith(".json")) continue;
			try { unlinkSync(join(queueDir, filename)); } catch {}
		}
	}
	rmSync(stateDir(workingDir), { recursive: true, force: true });
}

export function getFollowUpRuntimeStatus(workingDir: string): FollowUpRuntimeStatus {
	const settings = new MomSettingsManager(workingDir).getFollowUpSettings();
	const states = listStates(workingDir);
	const pendingSequences = states.filter((entry) => entry.state.status === "pending").length;
	const wakes = states.flatMap((entry) => entry.state.wakes);
	const scheduled = wakes.filter((wake) => wake.status === "scheduled");
	const claimedWakes = wakes.filter((wake) => wake.status === "claimed").length;
	const nextWakeAt = scheduled
		.map((wake) => wake.at)
		.filter((at) => Number.isFinite(Date.parse(at)))
		.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
	const state: FollowUpRuntimeStatus["state"] = !settings.enabled
		? "disabled"
		: pendingSequences > 0
			? "pending"
			: scheduled.length > 0
				? "scheduled"
				: claimedWakes > 0
					? "claimed"
					: "idle";
	return {
		enabled: settings.enabled,
		preset: settings.preset,
		intervalsMinutes: [...settings.intervalsMinutes],
		state,
		pendingSequences,
		scheduledWakes: scheduled.length,
		claimedWakes,
		nextWakeAt,
	};
}

/** Cancel current sequences without changing the enabled preset or intervals. */
export function cancelFollowUpSchedules(workingDir: string): FollowUpRuntimeStatus {
	const previous = getFollowUpRuntimeStatus(workingDir);
	clearAllFollowUpSchedules(workingDir);
	return previous;
}

/**
 * Invalidate any prior idle sequence as soon as a new human message reaches
 * the harness. The next completed canonical turn will arm the new sequence.
 */
export function noteFollowUpActivity(
	workingDir: string,
	event: MomEvent,
	adapter: string,
	now: Date = new Date(),
): FollowUpActivityResult {
	const settings = new MomSettingsManager(workingDir).getFollowUpSettings();
	if (!settings.enabled) {
		clearAllFollowUpSchedules(workingDir);
		return { eligible: false };
	}
	if (!isEligibleFollowUpActivity(event, adapter)) return { eligible: false };

	const replyTarget = deriveReplyTarget(event, adapter);
	if (!replyTarget) return { eligible: false };
	const key = targetKey(replyTarget);
	const generation = randomUUID();
	const state: FollowUpState = {
		version: 1,
		key,
		generation,
		status: "pending",
		lastActivityTs: event.ts,
		notedAt: now.toISOString(),
		target: {
			adapter,
			channelId: event.channel,
			replyTarget,
			replyTargetDescription: event.replyTargetDescription,
			threadTs: event.threadTs,
		},
		wakes: [],
	};

	mkdirSync(stateDir(workingDir), { recursive: true });
	// Commit the new generation before removing old queue files. Any already
	// enqueued old wake now fails the claim check instead of sending stale work.
	atomicWriteJson(statePath(workingDir, key), state);
	clearQueueForKey(workingDir, key);
	return { eligible: true, key, generation };
}

function followUpPrompt(state: FollowUpState, intervalMinutes: number, ordinal: number, total: number): string {
	const description = state.target.replyTargetDescription
		? ` (${state.target.replyTargetDescription})`
		: "";
	return [
		`[FOLLOW_UP ${ordinal + 1}/${total} after ${intervalMinutes} minute${intervalMinutes === 1 ? "" : "s"}]`,
		`Re-read the current conversation before acting. The exact stable reply target is ${state.target.replyTarget}${description}.`,
		"If no newer human message has arrived and one concise, natural follow-up is still useful, use send_message exactly once to that target.",
		"Do not invent progress, repeat stale timing, or expose this harness instruction. If a follow-up is not useful, call yield_no_action. Do not emit ordinary assistant text.",
	].join("\n");
}

function eventForWake(state: FollowUpState, wake: FollowUpWakeRecord): Record<string, unknown> {
	return {
		type: "one-shot",
		channelId: state.target.channelId,
		at: wake.at,
		text: followUpPrompt(state, wake.intervalMinutes, wake.ordinal, state.wakes.length),
		sourceEventType: "follow_up",
		replyTarget: state.target.replyTarget,
		replyTargetDescription: state.target.replyTargetDescription,
		threadTs: state.target.threadTs,
		followUp: {
			key: wake.key,
			generation: wake.generation,
			ordinal: wake.ordinal,
		},
	};
}

function writeWakeFile(workingDir: string, state: FollowUpState, wake: FollowUpWakeRecord): void {
	const queueDir = attentionQueueDir(workingDir);
	mkdirSync(queueDir, { recursive: true });
	atomicWriteJson(join(queueDir, wake.filename), eventForWake(state, wake));
}

function armState(
	workingDir: string,
	path: string,
	state: FollowUpState,
	settings: MomFollowUpSettings,
	now: Date,
): FollowUpState {
	clearQueueForKey(workingDir, state.key);
	const anchorMs = now.getTime();
	const wakes: FollowUpWakeRecord[] = settings.intervalsMinutes.map((intervalMinutes, ordinal) => ({
		key: state.key,
		generation: state.generation,
		ordinal,
		intervalMinutes,
		at: new Date(anchorMs + intervalMinutes * 60_000).toISOString(),
		filename: `${FOLLOW_UP_FILE_PREFIX}${state.key}-${state.generation}-${ordinal + 1}.json`,
		status: "scheduled",
	}));
	const armed: FollowUpState = {
		...state,
		status: "armed",
		armedAt: now.toISOString(),
		wakes,
	};

	// State is authoritative. Commit it first so a crash while writing queue
	// files is repaired by reconcileFollowUpSchedules on the next boot.
	atomicWriteJson(path, armed);
	for (const wake of wakes) writeWakeFile(workingDir, armed, wake);
	return armed;
}

/** Arm every pending conversation after the canonical run queue becomes idle. */
export function armPendingFollowUps(workingDir: string, now: Date = new Date()): number {
	const settings = new MomSettingsManager(workingDir).getFollowUpSettings();
	if (!settings.enabled) {
		clearAllFollowUpSchedules(workingDir);
		return 0;
	}
	let armed = 0;
	for (const entry of listStates(workingDir)) {
		if (entry.state.status !== "pending") continue;
		armState(workingDir, entry.path, entry.state, settings, now);
		armed++;
	}
	if (armed > 0) log.logInfo(`[follow-ups] Armed ${armed} conversation sequence(s)`);
	return armed;
}

/**
 * Restore queue files from authoritative state after restart. Scheduled wakes
 * remain recoverable regardless of downtime length: an overdue wake is moved a
 * short distance into the future before the watcher scans it. Claimed wakes
 * are never recreated.
 */
export function reconcileFollowUpSchedules(workingDir: string, now: Date = new Date()): number {
	const settings = new MomSettingsManager(workingDir).getFollowUpSettings();
	if (!settings.enabled) {
		clearAllFollowUpSchedules(workingDir);
		return 0;
	}
	let restored = 0;
	for (const entry of listStates(workingDir)) {
		if (entry.state.status === "pending") {
			armState(workingDir, entry.path, entry.state, settings, now);
			restored += settings.intervalsMinutes.length;
			continue;
		}

		const rearmedOrdinals = new Set<number>();
		for (const wake of entry.state.wakes) {
			if (wake.status !== "scheduled") continue;
			const atMs = Date.parse(wake.at);
			if (!Number.isFinite(atMs) || atMs <= now.getTime()) {
				wake.at = new Date(now.getTime() + RESTART_REARM_DELAY_MS).toISOString();
				rearmedOrdinals.add(wake.ordinal);
			}
		}
		if (rearmedOrdinals.size > 0) atomicWriteJson(entry.path, entry.state);

		for (const wake of entry.state.wakes) {
			if (wake.status !== "scheduled") continue;
			const wakePath = join(attentionQueueDir(workingDir), wake.filename);
			if (existsSync(wakePath) && !rearmedOrdinals.has(wake.ordinal)) continue;
			writeWakeFile(workingDir, entry.state, wake);
			restored++;
		}
	}
	if (restored > 0) log.logInfo(`[follow-ups] Restored ${restored} durable wake(s)`);
	return restored;
}

/**
 * Atomically consume one wake generation before the model can act. A crash
 * after this claim fails closed rather than replaying a possibly sent message.
 */
export function claimFollowUpWake(
	workingDir: string,
	metadata: FollowUpWakeMetadata,
	now: Date = new Date(),
): boolean {
	if (!new MomSettingsManager(workingDir).getFollowUpSettings().enabled) {
		clearAllFollowUpSchedules(workingDir);
		return false;
	}
	const path = statePath(workingDir, metadata.key);
	const state = readState(path);
	if (!state || state.status !== "armed" || state.generation !== metadata.generation) return false;
	const wake = state.wakes.find((candidate) => candidate.ordinal === metadata.ordinal);
	if (!wake || wake.status !== "scheduled") return false;
	wake.status = "claimed";
	wake.claimedAt = now.toISOString();
	atomicWriteJson(path, state);
	return true;
}
