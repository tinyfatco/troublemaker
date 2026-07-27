import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { MomEvent, RunResult } from "../adapters/types.js";
import type { MomFollowUpSettings } from "../context.js";
import { attentionQueueDir } from "./paths.js";

export const POST_RUN_FOLLOW_UP_CHANNEL_ID = "follow-up";
export const POST_RUN_FOLLOW_UP_SOURCE_PREFIX = "post_run_follow_up";
export const DEFAULT_FOLLOW_UP_OFFSETS_MINUTES = [1, 3, 5, 10] as const;
export const MAX_FOLLOW_UP_OFFSETS = 16;
export const MAX_FOLLOW_UP_OFFSET_MINUTES = 7 * 24 * 60;

const STATE_VERSION = 1;
const STATE_FILE = "post-run-follow-up-state.json";
const QUEUE_FILE_PREFIX = "post-run-follow-up-";
const SAFE_ID = /^[A-Za-z0-9-]+$/;
const FOLLOW_UP_PROMPT = `Review the current conversation context and determine the next reasonable action, if any. This is a finite post-run follow-up evaluation, not a heartbeat and not a promise to contact anyone. Use current evidence and take an appropriate action through available tools only when warranted. Do not announce or promise another follow-up. If no action is needed, call yield_no_action.`;

type FollowUpWakeStatus = "pending" | "claimed" | "completed" | "cancelled";
type FollowUpOutcome = "completed" | "failed" | "superseded";

interface FollowUpWake {
	id: string;
	index: number;
	offsetMinutes: number;
	at: string;
	status: FollowUpWakeStatus;
	claimedAt?: string;
	completedAt?: string;
	cancelledAt?: string;
	cancelReason?: string;
	outcome?: FollowUpOutcome;
}

interface FollowUpGeneration {
	id: string;
	scheduledAt: string;
	wakes: FollowUpWake[];
}

interface FollowUpState {
	version: 1;
	updatedAt: string;
	configuration: MomFollowUpSettings;
	generation: FollowUpGeneration | null;
}

export interface PostRunFollowUpClaim {
	generationId: string;
	wakeId: string;
}

export interface PostRunFollowUpStatus {
	enabled: boolean;
	offsetsMinutes: number[];
	generationId: string | null;
	scheduledAt: string | null;
	pending: number;
	claimed: number;
	completed: number;
	cancelled: number;
	nextWake: string | null;
}

export interface CancelPostRunFollowUpsResult {
	cancelled: number;
	status: PostRunFollowUpStatus;
}

export function normalizeFollowUpOffsets(value: unknown): number[] {
	if (!Array.isArray(value)) {
		throw new Error("follow-up offsets must be an array of minute values");
	}
	if (value.length === 0 || value.length > MAX_FOLLOW_UP_OFFSETS) {
		throw new Error(`follow-up offsets must contain between 1 and ${MAX_FOLLOW_UP_OFFSETS} values`);
	}

	const offsets = value.map((entry) => {
		if (typeof entry !== "number" || !Number.isInteger(entry)) {
			throw new Error("follow-up offsets must be whole minutes");
		}
		if (entry < 1 || entry > MAX_FOLLOW_UP_OFFSET_MINUTES) {
			throw new Error(`follow-up offsets must be between 1 and ${MAX_FOLLOW_UP_OFFSET_MINUTES} minutes`);
		}
		return entry;
	});

	for (let index = 1; index < offsets.length; index++) {
		if (offsets[index] <= offsets[index - 1]) {
			throw new Error("follow-up offsets must be unique and strictly increasing");
		}
	}
	return offsets;
}

export function isPostRunFollowUpEvent(event: Pick<MomEvent, "sourceEventType">): boolean {
	return parseFollowUpSource(event.sourceEventType) !== null;
}

export function shouldSchedulePostRunFollowUps(
	event: MomEvent,
	isScheduledEvent: boolean | undefined,
	result: RunResult,
): boolean {
	return isScheduledEvent !== true
		&& !isPostRunFollowUpEvent(event)
		&& event.user !== "EVENT"
		&& result.stopReason === "stop";
}

function formatFollowUpSource(generationId: string, wakeId: string): string {
	return `${POST_RUN_FOLLOW_UP_SOURCE_PREFIX}:${generationId}:${wakeId}`;
}

function parseFollowUpSource(sourceEventType: string | undefined): PostRunFollowUpClaim | null {
	if (!sourceEventType) return null;
	const parts = sourceEventType.split(":");
	if (parts.length !== 3 || parts[0] !== POST_RUN_FOLLOW_UP_SOURCE_PREFIX) return null;
	const generationId = parts[1]?.trim();
	const wakeId = parts[2]?.trim();
	if (!generationId || !wakeId || !SAFE_ID.test(generationId) || !SAFE_ID.test(wakeId)) {
		return null;
	}
	return { generationId, wakeId };
}

function sameConfiguration(a: MomFollowUpSettings, b: MomFollowUpSettings): boolean {
	return a.enabled === b.enabled
		&& a.offsetsMinutes.length === b.offsetsMinutes.length
		&& a.offsetsMinutes.every((offset, index) => offset === b.offsetsMinutes[index]);
}

function defaultState(configuration: MomFollowUpSettings, now: Date): FollowUpState {
	return {
		version: STATE_VERSION,
		updatedAt: now.toISOString(),
		configuration: {
			enabled: configuration.enabled,
			offsetsMinutes: [...configuration.offsetsMinutes],
		},
		generation: null,
	};
}

function isFollowUpState(value: unknown): value is FollowUpState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Partial<FollowUpState>;
	if (state.version !== STATE_VERSION || typeof state.updatedAt !== "string") return false;
	if (!state.configuration || typeof state.configuration.enabled !== "boolean") return false;
	try {
		normalizeFollowUpOffsets(state.configuration.offsetsMinutes);
	} catch {
		return false;
	}
	if (state.generation === null) return true;
	if (
		!state.generation
		|| typeof state.generation.id !== "string"
		|| !SAFE_ID.test(state.generation.id)
		|| typeof state.generation.scheduledAt !== "string"
		|| !Number.isFinite(new Date(state.generation.scheduledAt).getTime())
		|| !Array.isArray(state.generation.wakes)
		|| state.generation.wakes.length > MAX_FOLLOW_UP_OFFSETS
	) return false;
	const wakeIds = new Set<string>();
	const wakeIndexes = new Set<number>();
	for (const wake of state.generation.wakes) {
		if (
			!wake
			|| typeof wake.id !== "string"
			|| !SAFE_ID.test(wake.id)
			|| !Number.isInteger(wake.index)
			|| wake.index < 0
			|| wake.index >= MAX_FOLLOW_UP_OFFSETS
			|| !Number.isInteger(wake.offsetMinutes)
			|| wake.offsetMinutes < 1
			|| wake.offsetMinutes > MAX_FOLLOW_UP_OFFSET_MINUTES
			|| typeof wake.at !== "string"
			|| !Number.isFinite(new Date(wake.at).getTime())
			|| !["pending", "claimed", "completed", "cancelled"].includes(wake.status)
			|| wakeIds.has(wake.id)
			|| wakeIndexes.has(wake.index)
		) return false;
		wakeIds.add(wake.id);
		wakeIndexes.add(wake.index);
	}
	return true;
}

export class PostRunFollowUpScheduler {
	private readonly statePath: string;
	private readonly queueDir: string;

	constructor(
		private readonly workingDir: string,
		private readonly now: () => Date = () => new Date(),
		private readonly createId: () => string = () => randomUUID(),
	) {
		this.statePath = join(workingDir, "attention", STATE_FILE);
		this.queueDir = attentionQueueDir(workingDir);
	}

	reconcileConfiguration(configuration: MomFollowUpSettings): PostRunFollowUpStatus {
		const normalized: MomFollowUpSettings = {
			enabled: configuration.enabled,
			offsetsMinutes: normalizeFollowUpOffsets(configuration.offsetsMinutes),
		};
		const state = this.readState(normalized);
		let changed = false;
		if (!sameConfiguration(state.configuration, normalized)) {
			this.cancelPendingInState(state, normalized.enabled ? "reconfigured" : "disabled");
			state.configuration = normalized;
			changed = true;
		}
		if (this.rearmOverduePending(state)) changed = true;
		if (changed) this.writeState(state);
		this.reconcileQueueFiles(state);
		return this.statusFromState(state);
	}

	scheduleFromRunStop(configuration: MomFollowUpSettings): PostRunFollowUpStatus {
		this.reconcileConfiguration(configuration);
		const state = this.readState(configuration);
		if (!state.configuration.enabled) {
			this.reconcileQueueFiles(state);
			return this.statusFromState(state);
		}

		const now = this.now();
		const generationId = this.nextId();
		state.generation = {
			id: generationId,
			scheduledAt: now.toISOString(),
			wakes: state.configuration.offsetsMinutes.map((offsetMinutes, index) => ({
				id: this.nextId(),
				index,
				offsetMinutes,
				at: new Date(now.getTime() + offsetMinutes * 60_000).toISOString(),
				status: "pending",
			})),
		};
		this.writeState(state);
		this.reconcileQueueFiles(state);
		return this.statusFromState(state);
	}

	cancelPending(reason = "cancelled"): CancelPostRunFollowUpsResult {
		const state = this.readState({
			enabled: false,
			offsetsMinutes: [...DEFAULT_FOLLOW_UP_OFFSETS_MINUTES],
		});
		const cancelled = this.cancelPendingInState(state, reason);
		if (cancelled > 0) this.writeState(state);
		this.reconcileQueueFiles(state);
		return { cancelled, status: this.statusFromState(state) };
	}

	claim(sourceEventType: string | undefined): PostRunFollowUpClaim | null {
		const request = parseFollowUpSource(sourceEventType);
		if (!request) return null;
		const state = this.readState({
			enabled: false,
			offsetsMinutes: [...DEFAULT_FOLLOW_UP_OFFSETS_MINUTES],
		});
		if (state.generation?.id !== request.generationId) return null;
		const wake = state.generation.wakes.find((candidate) => candidate.id === request.wakeId);
		if (!wake || wake.status !== "pending") return null;

		wake.status = "claimed";
		wake.claimedAt = this.now().toISOString();
		this.writeState(state);
		this.reconcileQueueFiles(state);
		return request;
	}

	complete(claim: PostRunFollowUpClaim, outcome: FollowUpOutcome): PostRunFollowUpStatus {
		const state = this.readState({
			enabled: false,
			offsetsMinutes: [...DEFAULT_FOLLOW_UP_OFFSETS_MINUTES],
		});
		if (state.generation?.id !== claim.generationId) return this.statusFromState(state);
		const wake = state.generation.wakes.find((candidate) => candidate.id === claim.wakeId);
		if (!wake || wake.status !== "claimed") return this.statusFromState(state);

		wake.status = "completed";
		wake.completedAt = this.now().toISOString();
		wake.outcome = outcome;
		this.writeState(state);
		this.reconcileQueueFiles(state);
		return this.statusFromState(state);
	}

	getStatus(configuration?: MomFollowUpSettings): PostRunFollowUpStatus {
		if (configuration) return this.reconcileConfiguration(configuration);
		const state = this.readState({
			enabled: false,
			offsetsMinutes: [...DEFAULT_FOLLOW_UP_OFFSETS_MINUTES],
		});
		return this.statusFromState(state);
	}

	private readState(configuration: MomFollowUpSettings): FollowUpState {
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, "utf-8"));
			if (isFollowUpState(parsed)) return parsed;
		} catch {
			// Missing or invalid state is rebuilt from authoritative settings.
		}
		const rebuilt = defaultState(configuration, this.now());
		this.writeState(rebuilt);
		return rebuilt;
	}

	private writeState(state: FollowUpState): void {
		state.updatedAt = this.now().toISOString();
		this.atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
	}

	private rearmOverduePending(state: FollowUpState): boolean {
		const nowMs = this.now().getTime();
		let changed = false;
		for (const wake of state.generation?.wakes ?? []) {
			if (wake.status !== "pending") continue;
			const atMs = new Date(wake.at).getTime();
			if (Number.isFinite(atMs) && atMs > nowMs) continue;
			// The generic attention watcher has a bounded past-due grace window.
			// Move only still-pending durable wakes just into the future so a late
			// process restart cannot silently expire them.
			wake.at = new Date(nowMs + 1000).toISOString();
			changed = true;
		}
		return changed;
	}

	private cancelPendingInState(state: FollowUpState, reason: string): number {
		let cancelled = 0;
		const cancelledAt = this.now().toISOString();
		for (const wake of state.generation?.wakes ?? []) {
			if (wake.status !== "pending") continue;
			wake.status = "cancelled";
			wake.cancelledAt = cancelledAt;
			wake.cancelReason = reason;
			cancelled++;
		}
		return cancelled;
	}

	private statusFromState(state: FollowUpState): PostRunFollowUpStatus {
		const wakes = state.generation?.wakes ?? [];
		const pendingWakes = wakes.filter((wake) => wake.status === "pending");
		return {
			enabled: state.configuration.enabled,
			offsetsMinutes: [...state.configuration.offsetsMinutes],
			generationId: state.generation?.id ?? null,
			scheduledAt: state.generation?.scheduledAt ?? null,
			pending: pendingWakes.length,
			claimed: wakes.filter((wake) => wake.status === "claimed").length,
			completed: wakes.filter((wake) => wake.status === "completed").length,
			cancelled: wakes.filter((wake) => wake.status === "cancelled").length,
			nextWake: pendingWakes.map((wake) => wake.at).sort()[0] ?? null,
		};
	}

	private queueFilename(generationId: string, wake: FollowUpWake): string {
		return `${QUEUE_FILE_PREFIX}${generationId}-${String(wake.index + 1).padStart(2, "0")}.json`;
	}

	private queueEvent(generationId: string, wake: FollowUpWake): string {
		return `${JSON.stringify({
			type: "one-shot",
			channelId: POST_RUN_FOLLOW_UP_CHANNEL_ID,
			sourceEventType: formatFollowUpSource(generationId, wake.id),
			text: FOLLOW_UP_PROMPT,
			at: wake.at,
		}, null, 2)}\n`;
	}

	private reconcileQueueFiles(state: FollowUpState): void {
		mkdirSync(this.queueDir, { recursive: true });
		const expected = new Map<string, string>();
		if (state.generation) {
			for (const wake of state.generation.wakes) {
				if (wake.status !== "pending") continue;
				expected.set(
					this.queueFilename(state.generation.id, wake),
					this.queueEvent(state.generation.id, wake),
				);
			}
		}

		for (const filename of readdirSync(this.queueDir)) {
			if (!filename.startsWith(QUEUE_FILE_PREFIX) || !filename.endsWith(".json")) continue;
			if (expected.has(filename)) continue;
			try { unlinkSync(join(this.queueDir, filename)); } catch {}
		}

		for (const [filename, content] of expected) {
			const filePath = join(this.queueDir, filename);
			try {
				if (existsSync(filePath) && readFileSync(filePath, "utf-8") === content) continue;
			} catch {
				// Rewrite missing or unreadable queue entries from durable state.
			}
			this.atomicWrite(filePath, content);
		}
	}

	private nextId(): string {
		const id = this.createId();
		if (!SAFE_ID.test(id)) throw new Error("follow-up ID generator returned an unsafe value");
		return id;
	}

	private atomicWrite(path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.${this.nextId()}.tmp`;
		writeFileSync(temporary, content, "utf-8");
		try {
			renameSync(temporary, path);
		} finally {
			try { unlinkSync(temporary); } catch {}
		}
	}
}
