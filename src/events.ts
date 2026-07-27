import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { basename, join } from "path";
import type { MomEvent as MomIncomingEvent, PlatformAdapter } from "./adapters/types.js";
import { attentionHistoryDir, attentionQueueDir, legacyEventsDir } from "./attention/paths.js";
import * as log from "./log.js";

// ============================================================================
// Event Types
// ============================================================================

export interface ImmediateEvent {
	type: "immediate";
	channelId?: string;
	/** Optional stable classifier propagated to the synthetic incoming event. */
	sourceEventType?: string;
	text: string;
}

export interface OneShotEvent {
	type: "one-shot";
	channelId?: string;
	/** Optional stable classifier propagated to the synthetic incoming event. */
	sourceEventType?: string;
	text: string;
	at: string; // ISO 8601 with timezone offset
}

export interface PeriodicEvent {
	type: "periodic";
	channelId?: string;
	/** Optional stable classifier propagated to the synthetic incoming event. */
	sourceEventType?: string;
	text: string;
	schedule: string; // cron syntax
	timezone: string; // IANA timezone
	/** 0-1, adds jitter to the cron interval. 0 = exact cron, 0.3 = ±30% of interval */
	spontaneity?: number;
	/** Suppress fires during this window (HH:MM format, e.g. "23:00"-"07:00") */
	quietHours?: { start: string; end: string };
	/** If set, triggers a maintenance action instead of an agent run */
	action?: "compact";
}

export type ScheduledEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

export interface ScheduledWatcher {
	start(): void;
	stop(): void;
}

// ============================================================================
// EventsWatcher
// ============================================================================

/**
 * If a timestamp falls inside the quiet hours window, push it to the end.
 */
function pushPastQuietHours(
	timestampMs: number,
	quietHours: { start: string; end: string },
	timezone: string,
): number {
	const [startH, startM] = quietHours.start.split(":").map(Number);
	const [endH, endM] = quietHours.end.split(":").map(Number);

	const d = new Date(timestampMs);
	const timeStr = d.toLocaleTimeString("en-US", { timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit" });
	const [h, m] = timeStr.split(":").map(Number);

	const timeMinutes = h * 60 + m;
	const startMinutes = startH * 60 + startM;
	const endMinutes = endH * 60 + endM;

	let inQuiet: boolean;
	if (startMinutes <= endMinutes) {
		inQuiet = timeMinutes >= startMinutes && timeMinutes < endMinutes;
	} else {
		// Overnight: e.g. 23:00-07:00
		inQuiet = timeMinutes >= startMinutes || timeMinutes < endMinutes;
	}

	if (!inQuiet) return timestampMs;

	const dateStr = d.toLocaleDateString("en-CA", { timeZone: timezone });
	const endTarget = new Date(`${dateStr}T${quietHours.end}:00`);
	const tzDate = new Date(endTarget.toLocaleString("en-US", { timeZone: timezone }));
	const offset = endTarget.getTime() - tzDate.getTime();
	let endMs = endTarget.getTime() + offset;

	if (endMs <= timestampMs) {
		endMs += 24 * 60 * 60 * 1000;
	}

	return endMs;
}

const DEBOUNCE_MS = 100;
const FULL_RESCAN_DEBOUNCE_KEY = "__full_rescan__";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
/** Grace window for past-due one-shot events (10 minutes). Covers cold-start delay. */
const COLD_WAKE_GRACE_MS = 10 * 60 * 1000;

export interface JitteredPeriodicPlan {
	/** The canonical cron slot this timer belongs to. */
	baseRunMs: number;
	/** Delay from now until the jittered fire time. */
	delayMs: number;
}

/**
 * Plan one jittered periodic fire while preserving the canonical cron slot.
 *
 * `afterCronMs` is the slot consumed by the previous fire. Advancing from that
 * slot prevents an early (negative-jitter) fire from repeatedly scheduling the
 * same upcoming cron boundary.
 */
export function planNextJitteredPeriodicRun(
	event: PeriodicEvent,
	nowMs: number = Date.now(),
	randomValue: number = Math.random(),
	afterCronMs?: number,
): JitteredPeriodicPlan | null {
	const cron = new Cron(event.schedule, { timezone: event.timezone });
	const cursorMs = Math.max(nowMs, afterCronMs ?? nowMs);
	const nextCron = cron.nextRun(new Date(cursorMs));
	cron.stop();
	if (!nextCron) return null;

	const baseRunMs = nextCron.getTime();
	const baseDelayMs = baseRunMs - nowMs;
	const jitterMs = (randomValue * 2 - 1) * (event.spontaneity ?? 0) * baseDelayMs;
	let delayMs = Math.max(baseDelayMs + jitterMs, 90_000);

	if (event.quietHours) {
		const fireMs = nowMs + delayMs;
		const pushed = pushPastQuietHours(fireMs, event.quietHours, event.timezone);
		if (pushed !== fireMs) {
			delayMs = pushed - nowMs;
		}
	}

	return { baseRunMs, delayMs };
}

export class EventsWatcher {
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private crons: Map<string, Cron> = new Map();
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private startTime: number;
	private watcher: FSWatcher | null = null;
	private knownFiles: Set<string> = new Set();
	private initialScanTimer: NodeJS.Timeout | null = null;

	private onCompact?: () => Promise<void>;
	private initialScanDelayMs: number;
	private historyDir?: string;
	private ensureDir: boolean;
	private label: string;

	constructor(
		private eventsDir: string,
		private adapters: PlatformAdapter[],
		options?: { onCompact?: () => Promise<void>; initialScanDelayMs?: number; historyDir?: string; ensureDir?: boolean; label?: string },
	) {
		this.startTime = Date.now();
		this.onCompact = options?.onCompact;
		this.initialScanDelayMs = options?.initialScanDelayMs ?? 0;
		this.historyDir = options?.historyDir;
		this.ensureDir = options?.ensureDir ?? true;
		this.label = options?.label ?? basename(eventsDir);
	}

	/**
	 * Start watching for events. Call this after adapter is ready.
	 */
	start(): void {
		// Ensure attention queue directory exists. Legacy events watchers can opt
		// out so we do not recreate the old path on fresh workspaces.
		if (!existsSync(this.eventsDir)) {
			if (!this.ensureDir) {
				log.logInfo(`Scheduled prompt watcher skipped missing ${this.label} dir: ${this.eventsDir}`);
				return;
			}
			mkdirSync(this.eventsDir, { recursive: true });
		}

		log.logInfo(`Scheduled prompt watcher starting, dir: ${this.eventsDir}`);

		// Watch for changes immediately (fast)
		this.watcher = watch(this.eventsDir, (_eventType, filename) => {
			if (!filename) {
				this.debounce(FULL_RESCAN_DEBOUNCE_KEY, () => void this.scanExistingAsync());
				return;
			}
			if (!filename.endsWith(".json")) return;
			this.debounce(filename, () => this.handleFileChange(filename));
		});

		const runInitialScan = () => {
			this.initialScanTimer = null;
			// Scan existing files ASYNC — don't block the event loop.
			// On slow filesystems (s3fs/FUSE), readdir can take 60+ seconds.
			this.scanExistingAsync().then(() => {
				log.logInfo(`Scheduled prompt watcher started (${this.label}), tracking ${this.knownFiles.size} files`);
			});
		};

		if (this.initialScanDelayMs > 0) {
			log.logInfo(`Scheduled prompt watcher initial scan delayed by ${this.initialScanDelayMs}ms (${this.label})`);
			this.initialScanTimer = setTimeout(runInitialScan, this.initialScanDelayMs);
			this.initialScanTimer.unref?.();
			return;
		}

		runInitialScan();
	}

	/**
	 * Stop watching and cancel all scheduled events.
	 */
	stop(): void {
		if (this.initialScanTimer) {
			clearTimeout(this.initialScanTimer);
			this.initialScanTimer = null;
		}

		// Stop fs watcher
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}

		// Cancel all debounce timers
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		// Cancel all scheduled timers
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();

		// Cancel all cron jobs
		for (const cron of this.crons.values()) {
			cron.stop();
		}
		this.crons.clear();

		this.knownFiles.clear();
		log.logInfo(`Scheduled prompt watcher stopped (${this.label})`);
	}

	private debounce(filename: string, fn: () => void): void {
		const existing = this.debounceTimers.get(filename);
		if (existing) {
			clearTimeout(existing);
		}
		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private async scanExistingAsync(): Promise<void> {
		let files: string[];
		try {
			files = (await readdir(this.eventsDir)).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.logWarning(`Failed to read scheduled prompt directory (${this.label})`, String(err));
			return;
		}

		const currentFiles = new Set(files);
		for (const filename of [...this.knownFiles]) {
			if (!currentFiles.has(filename)) {
				this.handleDelete(filename);
			}
		}

		for (const filename of files) {
			if (this.knownFiles.has(filename)) continue;
			this.handleFile(filename);
		}
	}

	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);

		if (!existsSync(filePath)) {
			// File was deleted
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			// File was modified - cancel existing and re-schedule
			this.cancelScheduled(filename);
			this.handleFile(filename);
		} else {
			// New file
			this.handleFile(filename);
		}
	}

	private handleDelete(filename: string): void {
		if (!this.knownFiles.has(filename)) return;

		log.logInfo(`Scheduled prompt file deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
	}

	private cancelScheduled(filename: string): void {
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
		}

		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
		}
	}

	private async handleFile(filename: string): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		// Parse with retries
		let event: ScheduledEvent | null = null;
		let lastError: Error | null = null;

		for (let i = 0; i < MAX_RETRIES; i++) {
			try {
				const content = await readFile(filePath, "utf-8");
				event = this.parseEvent(content, filename);
				break;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (i < MAX_RETRIES - 1) {
					await this.sleep(RETRY_BASE_MS * 2 ** i);
				}
			}
		}

		if (!event) {
			log.logWarning(`Failed to parse scheduled prompt file after ${MAX_RETRIES} retries: ${filename}`, lastError?.message);
			this.deleteFile(filename);
			return;
		}

		this.knownFiles.add(filename);

		// Schedule based on type
		switch (event.type) {
			case "immediate":
				this.handleImmediate(filename, event);
				break;
			case "one-shot":
				this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	private parseEvent(content: string, filename: string): ScheduledEvent | null {
		const data = JSON.parse(content);

		if (!data.type || !data.text) {
			throw new Error(`Missing required fields (type, text) in ${filename}`);
		}

		const channelId = data.channelId || "heartbeat";
		const sourceEventType = typeof data.sourceEventType === "string" && data.sourceEventType.trim()
			? data.sourceEventType.trim()
			: undefined;

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelId, sourceEventType, text: data.text };

			case "one-shot":
				if (!data.at) {
					throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
				}
				return { type: "one-shot", channelId, sourceEventType, text: data.text, at: data.at };

			case "periodic":
				if (!data.schedule) {
					throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
				}
				if (!data.timezone) {
					throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
				}
				return {
					type: "periodic",
					channelId,
					sourceEventType,
					text: data.text,
					schedule: data.schedule,
					timezone: data.timezone,
					spontaneity: data.spontaneity,
					quietHours: data.quietHours,
					action: data.action,
				};

			default:
				throw new Error(`Unknown event type '${data.type}' in ${filename}`);
		}
	}

	private handleImmediate(filename: string, event: ImmediateEvent): void {
		const filePath = join(this.eventsDir, filename);

		// Check if stale (created before harness started)
		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime) {
				log.logInfo(`Stale immediate event, expiring: ${filename}`);
				this.completeFile(filename, "expired");
				return;
			}
		} catch {
			// File may have been deleted
			return;
		}

		log.logInfo(`Executing immediate scheduled prompt: ${filename}`);
		this.execute(filename, event);
	}

	private handleOneShot(filename: string, event: OneShotEvent): void {
		const atTime = new Date(event.at).getTime();
		const now = Date.now();

		if (atTime <= now) {
			const ageMs = now - atTime;
			if (ageMs <= COLD_WAKE_GRACE_MS) {
				// Past but within grace window — execute immediately.
				// Covers cold-start delay where container boots after the event's target time.
				log.logInfo(`One-shot scheduled prompt ${Math.round(ageMs / 1000)}s past due (within grace window), executing: ${filename}`);
				this.execute(filename, event);
				return;
			}
			// Too old — mark expired
			log.logInfo(`One-shot scheduled prompt ${Math.round(ageMs / 1000)}s past due (beyond grace window), expiring: ${filename}`);
			this.completeFile(filename, "expired");
			return;
		}

		const delay = atTime - now;
		log.logInfo(`Scheduling one-shot scheduled prompt: ${filename} in ${Math.round(delay / 1000)}s`);

		const timer = setTimeout(() => {
			this.timers.delete(filename);
			log.logInfo(`Executing one-shot scheduled prompt: ${filename}`);
			this.execute(filename, event);
		}, delay);

		this.timers.set(filename, timer);
	}

	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			if (event.spontaneity && event.spontaneity > 0) {
				// Jittered periodic: use cron to compute base intervals, add jitter via setTimeout
				this.scheduleJitteredPeriodic(filename, event);
			} else {
				// Standard cron: exact timing
				const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
					log.logInfo(`Executing periodic scheduled prompt: ${filename}`);
					this.execute(filename, event, false);
				});
				this.crons.set(filename, cron);
				const next = cron.nextRun();
				log.logInfo(`Scheduled periodic prompt: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`);
			}
		} catch (err) {
			log.logWarning(`Invalid cron schedule for scheduled prompt ${filename}: ${event.schedule}`, String(err));
			this.deleteFile(filename);
		}
	}

	/**
	 * Schedule a periodic event with jitter. Uses cron to compute the base
	 * next-fire time, then adds random jitter scaled by spontaneity.
	 * After each fire, reschedules with fresh jitter.
	 */
	private scheduleJitteredPeriodic(filename: string, event: PeriodicEvent, afterCronMs?: number): void {
		try {
			const now = Date.now();
			const plan = planNextJitteredPeriodicRun(event, now, Math.random(), afterCronMs);
			if (!plan) return;

			const fireTime = new Date(now + plan.delayMs).toISOString();
			log.logInfo(`Scheduled jittered periodic prompt: ${filename}, next fire: ${fireTime} (${Math.round(plan.delayMs / 1000)}s, spontaneity=${event.spontaneity})`);

			const timer = setTimeout(() => {
				this.timers.delete(filename);
				log.logInfo(`Executing jittered periodic scheduled prompt: ${filename}`);
				const sourceIsCurrent = this.execute(filename, event, false);
				if (!sourceIsCurrent) return;
				// Advance from the consumed cron slot, even when negative jitter fired early.
				this.scheduleJitteredPeriodic(filename, event, plan.baseRunMs);
			}, plan.delayMs);

			this.timers.set(filename, timer);
		} catch (err) {
			log.logWarning(`Failed to schedule jittered periodic prompt ${filename}`, String(err));
		}
	}

	private sourceMatchesScheduledEvent(filename: string, scheduledEvent: ScheduledEvent): boolean {
		const filePath = join(this.eventsDir, filename);
		try {
			const currentEvent = this.parseEvent(readFileSync(filePath, "utf-8"), filename);
			if (JSON.stringify(currentEvent) === JSON.stringify(scheduledEvent)) {
				return true;
			}

			log.logInfo(`Scheduled prompt source changed before execution, cancelling stale schedule: ${filename}`);
			this.cancelScheduled(filename);
			this.knownFiles.delete(filename);
			void this.handleFile(filename);
			return false;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			log.logInfo(`Scheduled prompt source missing or invalid before execution, cancelling: ${filename} (${detail})`);
			this.cancelScheduled(filename);
			this.knownFiles.delete(filename);
			return false;
		}
	}

	private execute(filename: string, event: ScheduledEvent, deleteAfter: boolean = true): boolean {
		if (!this.sourceMatchesScheduledEvent(filename, event)) {
			return false;
		}

		// Format the message
		let scheduleInfo: string;
		switch (event.type) {
			case "immediate":
				scheduleInfo = "immediate";
				break;
			case "one-shot":
				scheduleInfo = event.at;
				break;
			case "periodic":
				scheduleInfo = event.schedule;
				break;
		}

		// Handle maintenance actions (compact) — no agent run, just the operation
		if (event.type === "periodic" && (event as PeriodicEvent).action === "compact") {
			if (this.onCompact) {
				log.logInfo(`[auto-compact] Triggered by ${filename}`);
				this.onCompact().then(() => {
					log.logInfo("[auto-compact] Complete");
				}).catch((err) => {
					log.logInfo(`[auto-compact] Skipped: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
			return true;
		}

		const message = `[ATTENTION:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;

		// Create synthetic event
		const syntheticEvent: MomIncomingEvent = {
			type: "mention",
			channel: event.channelId || "heartbeat",
			user: "EVENT",
			text: message,
			ts: Date.now().toString(),
			sourceEventType: event.sourceEventType,
			directlyAddressed: false,
		};

		// Enqueue for processing — try each adapter until one accepts
		let enqueued = false;
		for (const adapter of this.adapters) {
			if (adapter.enqueueEvent(syntheticEvent)) {
				enqueued = true;
				break;
			}
		}

		if (enqueued && deleteAfter) {
			// Move to completed/ after successful enqueue (immediate and one-shot)
			this.completeFile(filename, "fired");
		} else if (!enqueued) {
			log.logWarning(`Scheduled prompt queue full, discarded: ${filename}`);
			// Still remove immediate/one-shot even if discarded
			if (deleteAfter) {
				this.completeFile(filename, "expired");
			}
		}

		return true;
	}

	private deleteFile(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch (err) {
			// ENOENT is fine (file already deleted), other errors are warnings
			if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
				log.logWarning(`Failed to delete event file: ${filename}`, String(err));
			}
		}
		this.knownFiles.delete(filename);
	}

	/**
	 * Move a fired/expired scheduled prompt to attention/history/ with metadata.
	 * Provides an audit trail instead of silent deletion.
	 */
	private completeFile(filename: string, outcome: "fired" | "expired"): void {
		const filePath = join(this.eventsDir, filename);
		const completedDir = this.historyDir ?? join(this.eventsDir, "completed");

		try {
			// Read the original event
			const content = readFileSync(filePath, "utf-8");
			const data = JSON.parse(content);

			// Add completion metadata
			data._completedAt = new Date().toISOString();
			data._outcome = outcome;

			// Ensure completed/ directory exists
			if (!existsSync(completedDir)) {
				mkdirSync(completedDir, { recursive: true });
			}

			// Write to completed/
			writeFileSync(join(completedDir, filename), JSON.stringify(data, null, 2), "utf-8");

			// Remove the original
			unlinkSync(filePath);
			log.logInfo(`Scheduled prompt ${outcome}: ${filename} → ${completedDir}`);
		} catch (err) {
			// Fall back to plain delete if anything goes wrong
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`completeFile failed for scheduled prompt ${filename} (falling back to delete): ${msg}`);
			try { unlinkSync(filePath); } catch {}
		}

		this.knownFiles.delete(filename);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Create and start an events watcher.
 */
export function createEventsWatcher(
	workspaceDir: string,
	adapters: PlatformAdapter[],
	options?: { onCompact?: () => Promise<void>; initialScanDelayMs?: number },
): ScheduledWatcher {
	const primary = new EventsWatcher(attentionQueueDir(workspaceDir), adapters, {
		...options,
		historyDir: attentionHistoryDir(workspaceDir),
		label: "attention/queue",
	});
	const legacyDir = legacyEventsDir(workspaceDir);
	const legacy = existsSync(legacyDir)
		? new EventsWatcher(legacyDir, adapters, { ...options, ensureDir: false, label: "events (legacy)" })
		: null;

	return {
		start(): void {
			primary.start();
			legacy?.start();
		},
		stop(): void {
			primary.stop();
			legacy?.stop();
		},
	};
}

// ============================================================================
// Exported schedule helpers (used by gateway /schedule endpoint)
// ============================================================================

/**
 * Parse a raw JSON string into a ScheduledEvent.
 * Returns null if the content is invalid.
 */
export function parseEventContent(content: string): ScheduledEvent | null {
	try {
		const data = JSON.parse(content);
		if (!data.type || !data.text) return null;

		const channelId = data.channelId || "heartbeat";
		const sourceEventType = typeof data.sourceEventType === "string" && data.sourceEventType.trim()
			? data.sourceEventType.trim()
			: undefined;

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelId, sourceEventType, text: data.text };
			case "one-shot":
				if (!data.at) return null;
				return { type: "one-shot", channelId, sourceEventType, text: data.text, at: data.at };
			case "periodic":
				if (!data.schedule || !data.timezone) return null;
				return {
					type: "periodic", channelId, sourceEventType, text: data.text,
					schedule: data.schedule, timezone: data.timezone,
					spontaneity: data.spontaneity, quietHours: data.quietHours,
					action: data.action,
				};
			default:
				return null;
		}
	} catch {
		return null;
	}
}

/**
 * Compute the full wake manifest for scheduled events.
 * Returns ALL event timestamps with stable IDs (filenames) — no event content.
 * The orchestrator stores these durably to schedule container wakes.
 * `nextWake` is derived (earliest timestamp) for backwards compat.
 */
export async function computeWakeManifest(eventsDir: string): Promise<{
	nextWake: string | null;
	events: Array<{ file: string; type: string; nextFire: string }>;
}> {
	return computeWakeManifestForDir(eventsDir);
}

export async function computeWorkspaceWakeManifest(workspaceDir: string): Promise<{
	nextWake: string | null;
	events: Array<{ file: string; type: string; nextFire: string }>;
}> {
	const manifests = await Promise.all([
		computeWakeManifestForDir(attentionQueueDir(workspaceDir), "attention/queue/"),
		computeWakeManifestForDir(legacyEventsDir(workspaceDir), "events/"),
	]);
	const events = manifests.flatMap((manifest) => manifest.events)
		.sort((a, b) => a.nextFire.localeCompare(b.nextFire));
	const nextWake = events[0]?.nextFire ?? null;
	return { nextWake, events };
}

async function computeWakeManifestForDir(eventsDir: string, filePrefix = ""): Promise<{
	nextWake: string | null;
	events: Array<{ file: string; type: string; nextFire: string }>;
}> {
	const result: Array<{ file: string; type: string; nextFire: string }> = [];

	if (!existsSync(eventsDir)) {
		return { nextWake: null, events: [] };
	}

	let files: string[];
	try {
		files = (await readdir(eventsDir)).filter((f) => f.endsWith(".json"));
	} catch {
		return { nextWake: null, events: [] };
	}

	for (const filename of files) {
		try {
			const content = await readFile(join(eventsDir, filename), "utf-8");
			const event = parseEventContent(content);
			if (!event) continue;

			if (event.type === "periodic") {
				try {
					const cron = new Cron(event.schedule, { timezone: event.timezone });
					const next = cron.nextRun();
					if (next) {
						result.push({ file: `${filePrefix}${filename}`, type: "periodic", nextFire: next.toISOString() });
					}
				} catch {
					// Invalid cron — skip
				}
			} else if (event.type === "one-shot") {
				const at = new Date(event.at);
				if (at.getTime() > Date.now()) {
					result.push({ file: `${filePrefix}${filename}`, type: "one-shot", nextFire: at.toISOString() });
				}
			}
			// Skip immediate events — they fire on creation, not on schedule
		} catch {
			// Skip unreadable files
		}
	}

	// Find earliest next fire time
	let earliest: string | null = null;
	for (const e of result) {
		if (!earliest || e.nextFire < earliest) {
			earliest = e.nextFire;
		}
	}

	return { nextWake: earliest, events: result };
}
