/**
 * Compaction plumbing for the runner: the timeout, status tracking with an
 * exact cancellation timer, and the settings view Pi's AgentSession sees.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isClaudeCliProvider } from "../claude-cli.js";
import { isCodexCliProvider } from "../codex-cli.js";
import { playCompactionCue } from "../compaction-cue.js";
import type { MomSettingsManager } from "../context.js";
import * as log from "../log.js";

export interface CompactionStatus {
	reason: string;
	startedAt: number;
	timeoutAt: number;
	abortRequestedAt?: number;
}

export const DEFAULT_COMPACTION_TIMEOUT_MS = 6 * 60 * 1000;
const MIN_COMPACTION_TIMEOUT_MS = 30 * 1000;
const MAX_COMPACTION_TIMEOUT_MS = 30 * 60 * 1000;

export function resolveCompactionTimeoutMs(value = process.env.MOM_COMPACTION_TIMEOUT_MS): number {
	if (!value?.trim()) return DEFAULT_COMPACTION_TIMEOUT_MS;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_COMPACTION_TIMEOUT_MS;
	return Math.max(MIN_COMPACTION_TIMEOUT_MS, Math.min(MAX_COMPACTION_TIMEOUT_MS, Math.floor(parsed)));
}

/** Claude/Codex CLI models own their own context lifecycle (and compaction). */
export function isCliHarnessProvider(provider: string | undefined): boolean {
	return isClaudeCliProvider(provider) || isCodexCliProvider(provider);
}

/**
 * Track the in-progress compaction (manual or automatic) and abort it if it
 * outlives `timeoutMs`.
 */
export function createCompactionTracker(timeoutMs: number, getSession: () => AgentSession | null) {
	const compactionTimeoutMs = timeoutMs;
	let compactionStatus: CompactionStatus | null = null;
	let compactionTimer: ReturnType<typeof setTimeout> | undefined;
	const requestCompactionAbort = (): boolean => {
		const session = getSession();
		if (!session || !compactionStatus) return false;
		compactionStatus.abortRequestedAt ??= Date.now();
		session.abortCompaction();
		return true;
	};
	const beginCompaction = (reason: unknown) => {
		const alreadyCompacting = compactionStatus !== null;
		if (compactionTimer) clearTimeout(compactionTimer);
		const startedAt = Date.now();
		compactionStatus = {
			reason: typeof reason === "string" && reason ? reason : "unknown",
			startedAt,
			timeoutAt: startedAt + compactionTimeoutMs,
		};
		if (!alreadyCompacting) playCompactionCue();
		compactionTimer = setTimeout(() => {
			if (!compactionStatus || compactionStatus.startedAt !== startedAt) return;
			log.logWarning(`[compaction] Timed out after ${compactionTimeoutMs}ms; requesting cancellation`);
			requestCompactionAbort();
		}, compactionTimeoutMs);
		compactionTimer.unref?.();
	};
	const finishCompaction = () => {
		if (compactionTimer) clearTimeout(compactionTimer);
		compactionTimer = undefined;
		compactionStatus = null;
	};
	return {
		beginCompaction,
		finishCompaction,
		requestCompactionAbort,
		getStatus: (): CompactionStatus | null => compactionStatus,
	};
}

/**
 * Claude CLI owns its context lifecycle. Handoff mode also disables only
 * Pi's automatic semantic compaction; native remains the safe default.
 */
export function createCompactionSettingsProxy(
	settingsManager: MomSettingsManager,
	getModelProvider: () => string | undefined,
): MomSettingsManager {
	return new Proxy(settingsManager, {
		get(target, prop, receiver) {
			if (prop === "getCompactionEnabled") {
				return () => isCliHarnessProvider(getModelProvider())
					|| target.getCompactionSettings().mode === "handoff"
					? false
					: target.getCompactionEnabled();
			}
			if (prop === "getCompactionSettings") {
				return () => {
					const base = target.getCompactionSettings();
					if (isCliHarnessProvider(getModelProvider()) || base.mode === "handoff") {
						return { ...base, enabled: false };
					}
					return base;
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}
