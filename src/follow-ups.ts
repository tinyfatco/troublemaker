import { randomUUID } from "crypto";
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
import { isGoalContinuationEvent } from "./goal-continuation.js";
import * as log from "./log.js";

const FOLLOW_UP_STATE_DIR = join("attention", "follow-ups");
const FOLLOW_UP_STATE_FILE = "agent-global.json";
const FOLLOW_UP_STATE_KEY = "agent-global";
const FOLLOW_UP_FILE_PREFIX = "follow-up-";
const RESTART_REARM_DELAY_MS = 30_000;

interface FollowUpWakeRecord extends FollowUpWakeMetadata {
	intervalMinutes: number;
	at: string;
	filename: string;
	status: "scheduled" | "claimed";
	claimedAt?: string;
}

interface FollowUpState {
	version: 2;
	key: typeof FOLLOW_UP_STATE_KEY;
	generation: string;
	status: "pending" | "armed";
	lastWakeTs: string;
	completedAt: string;
	armedAt?: string;
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

function statePath(workingDir: string): string {
	return join(stateDir(workingDir), FOLLOW_UP_STATE_FILE);
}

function atomicWriteJson(path: string, value: unknown): void {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	renameSync(temp, path);
}

function readState(path: string): FollowUpState | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as FollowUpState;
		if (
			parsed.version !== 2
			|| parsed.key !== FOLLOW_UP_STATE_KEY
			|| !parsed.generation
			|| !parsed.lastWakeTs
			|| !parsed.completedAt
			|| !Array.isArray(parsed.wakes)
		) return null;
		return parsed;
	} catch {
		return null;
	}
}

function currentState(workingDir: string): { path: string; state: FollowUpState } | null {
	const path = statePath(workingDir);
	const state = readState(path);
	return state ? { path, state } : null;
}

function removeLegacyStateFiles(workingDir: string): void {
	const dir = stateDir(workingDir);
	if (!existsSync(dir)) return;
	for (const filename of readdirSync(dir)) {
		if (filename === FOLLOW_UP_STATE_FILE || !filename.endsWith(".json")) continue;
		try { unlinkSync(join(dir, filename)); } catch {}
	}
}

function clearFollowUpQueue(workingDir: string, keepFilenames: ReadonlySet<string> = new Set()): void {
	const queueDir = attentionQueueDir(workingDir);
	if (!existsSync(queueDir)) return;
	for (const filename of readdirSync(queueDir)) {
		if (!filename.startsWith(FOLLOW_UP_FILE_PREFIX) || !filename.endsWith(".json")) continue;
		if (keepFilenames.has(filename)) continue;
		try { unlinkSync(join(queueDir, filename)); } catch {}
	}
}

/**
 * A completed canonical wake is eligible regardless of transport, channel, or
 * conversation. Only semantically generated internal continuations are
 * excluded; control-only commands never reach the canonical completion hook.
 */
export function isEligibleFollowUpWake(event: MomEvent): boolean {
	if (event.followUp || event.sourceEventType === "follow_up") return false;
	if (isGoalContinuationEvent(event)) return false;
	return true;
}

export function clearAllFollowUpSchedules(workingDir: string): void {
	clearFollowUpQueue(workingDir);
	rmSync(stateDir(workingDir), { recursive: true, force: true });
}

export function getFollowUpRuntimeStatus(workingDir: string): FollowUpRuntimeStatus {
	const settings = new MomSettingsManager(workingDir).getFollowUpSettings();
	const current = currentState(workingDir)?.state;
	const pendingSequences = current?.status === "pending" ? 1 : 0;
	const wakes = current?.wakes ?? [];
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

/** Cancel the current agent-global sequence without changing its settings. */
export function cancelFollowUpSchedules(workingDir: string): FollowUpRuntimeStatus {
	const previous = getFollowUpRuntimeStatus(workingDir);
	clearAllFollowUpSchedules(workingDir);
	return previous;
}

/**
 * Replace the one agent-global checkpoint sequence after an eligible canonical
 * wake completes. No conversation or reply target is retained.
 */
export function noteCompletedFollowUpWake(
	workingDir: string,
	event: MomEvent,
	now: Date = new Date(),
): FollowUpActivityResult {
	const settings = new MomSettingsManager(workingDir).getFollowUpSettings();
	if (!settings.enabled) {
		clearAllFollowUpSchedules(workingDir);
		return { eligible: false };
	}
	if (!isEligibleFollowUpWake(event)) return { eligible: false };

	const generation = randomUUID();
	const state: FollowUpState = {
		version: 2,
		key: FOLLOW_UP_STATE_KEY,
		generation,
		status: "pending",
		lastWakeTs: event.ts,
		completedAt: now.toISOString(),
		wakes: [],
	};

	mkdirSync(stateDir(workingDir), { recursive: true });
	// The single state file is the generation authority. Commit the replacement
	// before deleting old queue files so an already-enqueued stale wake fails its
	// claim even during replacement.
	atomicWriteJson(statePath(workingDir), state);
	removeLegacyStateFiles(workingDir);
	clearFollowUpQueue(workingDir);
	return { eligible: true, key: FOLLOW_UP_STATE_KEY, generation };
}

function followUpPrompt(intervalMinutes: number, ordinal: number, total: number): string {
	return [
		`[FOLLOW_UP ${ordinal + 1}/${total} after ${intervalMinutes} minute${intervalMinutes === 1 ? "" : "s"} since the latest completed wake]`,
		"This is an agent-global internal checkpoint. It does not belong to any conversation and carries no assumed reply target.",
		"Review open loops across the agent. Use list_channels and read_thread when useful to recover the current context before acting.",
		"If one concise, natural follow-up is still useful, call send_message exactly once with the appropriate explicit target. Otherwise call yield_no_action.",
		"Do not invent progress, repeat stale timing, or expose this harness instruction. Do not emit ordinary assistant text.",
	].join("\n");
}

function eventForWake(state: FollowUpState, wake: FollowUpWakeRecord): Record<string, unknown> {
	return {
		type: "one-shot",
		channelId: "follow-up",
		at: wake.at,
		text: followUpPrompt(wake.intervalMinutes, wake.ordinal, state.wakes.length),
		sourceEventType: "follow_up",
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
	const anchorMs = now.getTime();
	const wakes: FollowUpWakeRecord[] = settings.intervalsMinutes.map((intervalMinutes, ordinal) => ({
		key: FOLLOW_UP_STATE_KEY,
		generation: state.generation,
		ordinal,
		intervalMinutes,
		at: new Date(anchorMs + intervalMinutes * 60_000).toISOString(),
		filename: `${FOLLOW_UP_FILE_PREFIX}${FOLLOW_UP_STATE_KEY}-${state.generation}-${ordinal + 1}.json`,
		status: "scheduled",
	}));
	const armed: FollowUpState = {
		...state,
		status: "armed",
		armedAt: now.toISOString(),
		wakes,
	};

	// State is authoritative. Commit it first so a crash while replacing queue
	// files is repaired by reconcileFollowUpSchedules on the next boot.
	atomicWriteJson(path, armed);
	clearFollowUpQueue(workingDir);
	for (const wake of wakes) writeWakeFile(workingDir, armed, wake);
	return armed;
}

/** Arm the one pending agent-global sequence after the run queue becomes idle. */
export function armPendingFollowUps(workingDir: string, now: Date = new Date()): number {
	const settings = new MomSettingsManager(workingDir).getFollowUpSettings();
	if (!settings.enabled) {
		clearAllFollowUpSchedules(workingDir);
		return 0;
	}
	const current = currentState(workingDir);
	if (!current || current.state.status !== "pending") return 0;
	armState(workingDir, current.path, current.state, settings, now);
	log.logInfo("[follow-ups] Armed the agent-global checkpoint sequence");
	return 1;
}

/**
 * Restore the current global generation after restart. Legacy per-conversation
 * state and queue files are discarded rather than inheriting an old target.
 */
export function reconcileFollowUpSchedules(workingDir: string, now: Date = new Date()): number {
	const settings = new MomSettingsManager(workingDir).getFollowUpSettings();
	if (!settings.enabled) {
		clearAllFollowUpSchedules(workingDir);
		return 0;
	}

	const current = currentState(workingDir);
	removeLegacyStateFiles(workingDir);
	const retainedQueueFiles = new Set(
		(current?.state.wakes ?? [])
			.filter((wake) => wake.status === "scheduled")
			.map((wake) => wake.filename),
	);
	clearFollowUpQueue(workingDir, retainedQueueFiles);
	if (!current) {
		try { unlinkSync(statePath(workingDir)); } catch {}
		return 0;
	}
	if (current.state.status === "pending") {
		armState(workingDir, current.path, current.state, settings, now);
		return settings.intervalsMinutes.length;
	}

	const rearmedOrdinals = new Set<number>();
	for (const wake of current.state.wakes) {
		if (wake.status !== "scheduled") continue;
		const atMs = Date.parse(wake.at);
		if (!Number.isFinite(atMs) || atMs <= now.getTime()) {
			wake.at = new Date(now.getTime() + RESTART_REARM_DELAY_MS).toISOString();
			rearmedOrdinals.add(wake.ordinal);
		}
	}
	if (rearmedOrdinals.size > 0) atomicWriteJson(current.path, current.state);

	let restored = 0;
	for (const wake of current.state.wakes) {
		if (wake.status !== "scheduled") continue;
		const wakePath = join(attentionQueueDir(workingDir), wake.filename);
		if (existsSync(wakePath) && !rearmedOrdinals.has(wake.ordinal)) continue;
		writeWakeFile(workingDir, current.state, wake);
		restored++;
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
	if (metadata.key !== FOLLOW_UP_STATE_KEY) return false;
	const current = currentState(workingDir);
	if (!current || current.state.status !== "armed" || current.state.generation !== metadata.generation) return false;
	const wake = current.state.wakes.find((candidate) => candidate.ordinal === metadata.ordinal);
	if (!wake || wake.status !== "scheduled") return false;
	wake.status = "claimed";
	wake.claimedAt = now.toISOString();
	atomicWriteJson(current.path, current.state);
	return true;
}
