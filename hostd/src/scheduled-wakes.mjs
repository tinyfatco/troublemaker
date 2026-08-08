import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Cron } from "croner";
import { contextWorkspacePath } from "./runtime.mjs";

const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/;
const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_JITTER_FRACTION = 0.45;

function iso(timestampMs) {
	return new Date(timestampMs).toISOString();
}

function descriptorPath(handle, child) {
	const base = `/proc/self/fd/${handle.fd}`;
	return child === undefined ? base : `${base}/${child}`;
}

async function openDirectory(path) {
	const handle = await open(
		path,
		fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
	);
	const information = await handle.stat();
	if (!information.isDirectory()) {
		await handle.close();
		throw new Error("scheduled prompt custody path is not a directory");
	}
	return handle;
}

async function openAttentionCustody(target, contextId) {
	const handles = [];
	try {
		const root = await openDirectory(resolve(target.contextsDirectory));
		handles.push(root);
		const contextName = basename(dirname(contextWorkspacePath(target, contextId)));
		if (!/^[A-Za-z0-9_.-]+$/.test(contextName)) throw new Error("context directory name is invalid");
		for (const component of [contextName, "workspace", "attention"]) {
			const child = await openDirectory(descriptorPath(handles.at(-1), component));
			handles.push(child);
		}
		return {
			attention: handles.at(-1),
			handles,
			async close() {
				for (const handle of handles.reverse()) await handle.close();
			},
		};
	} catch (error) {
		for (const handle of handles.reverse()) await handle.close();
		throw error;
	}
}

async function openScheduleDirectory(target, contextId, name, { create = false } = {}) {
	const custody = await openAttentionCustody(target, contextId);
	try {
		if (create) {
			try {
				await mkdir(descriptorPath(custody.attention, name), { mode: 0o700 });
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
			}
		}
		const directory = await openDirectory(descriptorPath(custody.attention, name));
		custody.handles.push(directory);
		return {
			...custody,
			directory,
			path: descriptorPath(directory),
		};
	} catch (error) {
		await custody.close();
		throw error;
	}
}

function boundedText(value, label, maximum, { optional = false } = {}) {
	if (value === undefined && optional) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
	}
	return value;
}

function validateTimezone(value) {
	const timezone = boundedText(value, "timezone", 128);
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
	} catch {
		throw new Error("timezone must be a valid IANA timezone");
	}
	return timezone;
}

function validateQuietHours(value) {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("quietHours must be an object");
	}
	if (!TIME_OF_DAY.test(value.start) || !TIME_OF_DAY.test(value.end)) {
		throw new Error("quietHours.start and quietHours.end must use HH:MM");
	}
	return { start: value.start, end: value.end };
}

function localHourMinute(timestampMs, timezone) {
	return Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value]),
	);
}

function pushPastQuietHours(timestampMs, quietHours, timezone) {
	if (!quietHours) return timestampMs;
	const [startHour, startMinute] = quietHours.start.split(":").map(Number);
	const [endHour, endMinute] = quietHours.end.split(":").map(Number);
	const parts = localHourMinute(timestampMs, timezone);
	const minute = Number(parts.hour) * 60 + Number(parts.minute);
	const start = startHour * 60 + startMinute;
	const end = endHour * 60 + endMinute;
	const inside = start <= end
		? minute >= start && minute < end
		: minute >= start || minute < end;
	if (!inside) return timestampMs;

	// Search forward by minutes rather than guessing the UTC offset. This stays
	// deterministic through DST gaps and repeated local times.
	const limit = timestampMs + 26 * 60 * 60 * 1000;
	for (let candidate = timestampMs + 60_000; candidate <= limit; candidate += 60_000) {
		const local = localHourMinute(candidate, timezone);
		if (Number(local.hour) === endHour && Number(local.minute) === endMinute) return candidate;
	}
	throw new Error("quiet-hours boundary could not be resolved");
}

function deterministicFraction(key) {
	const digest = createHash("sha256").update(key).digest();
	return digest.readUIntBE(0, 6) / 0x1000000000000;
}

function cronRuns(event, afterMs, count = 2) {
	const cron = new Cron(event.schedule, { timezone: event.timezone });
	try {
		const runs = [];
		let cursor = new Date(afterMs);
		for (let index = 0; index < count; index++) {
			const next = cron.nextRun(cursor);
			if (!next) break;
			runs.push(next.getTime());
			cursor = next;
		}
		return runs;
	} finally {
		cron.stop();
	}
}

function cronNeighbors(event, slotMs) {
	const cron = new Cron(event.schedule, { timezone: event.timezone });
	try {
		const following = cron.nextRun(new Date(slotMs));
		if (!following) throw new Error("periodic schedule has no following slot");
		let lookbackMs = 60_000;
		for (let attempt = 0; attempt < 32; attempt++) {
			let low = slotMs - lookbackMs;
			const candidate = cron.nextRun(new Date(low));
			if (candidate && candidate.getTime() < slotMs) {
				let high = slotMs - 1;
				while (high - low > 1) {
					const middle = Math.floor((low + high) / 2);
					const next = cron.nextRun(new Date(middle));
					if (next && next.getTime() < slotMs) low = middle;
					else high = middle;
				}
				const previous = cron.nextRun(new Date(low));
				if (previous && previous.getTime() < slotMs) return { previous, following };
			}
			lookbackMs *= 2;
		}
		throw new Error("periodic schedule has no bounded previous slot");
	} finally {
		cron.stop();
	}
}

export function planPeriodicOccurrence(event, {
	afterSlotMs,
	deterministicKey,
} = {}) {
	const cursor = afterSlotMs ?? Date.now();
	const [slotMs] = cronRuns(event, cursor, 1);
	if (!Number.isFinite(slotMs)) return null;
	let fireMs = slotMs;
	if ((event.spontaneity ?? 0) > 0) {
		const neighbors = cronNeighbors(event, slotMs);
		const previousGapMs = slotMs - neighbors.previous.getTime();
		const followingGapMs = neighbors.following.getTime() - slotMs;
		const safeIntervalMs = Math.min(previousGapMs, followingGapMs);
		const jitterFraction = Math.min(event.spontaneity, MAX_JITTER_FRACTION);
		const unit = deterministicFraction(`${deterministicKey}:${iso(slotMs)}`);
		fireMs = slotMs + (unit * 2 - 1) * jitterFraction * safeIntervalMs;
	}
	fireMs = pushPastQuietHours(Math.round(fireMs / 1000) * 1000, event.quietHours, event.timezone);
	return { slotMs, fireMs };
}

export function parseHostScheduledEvent(content, {
	nowMs = Date.now(),
	maximumPromptBytes = 32 * 1024,
	minimumPeriodicSeconds = 300,
	maximumHorizonDays = 366,
	deterministicKey = "schedule",
} = {}) {
	let data;
	try {
		data = JSON.parse(content);
	} catch {
		throw new Error("schedule file must contain valid JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("schedule file must contain an object");
	}
	if (!["one-shot", "periodic"].includes(data.type)) {
		throw new Error("Hostd owns only one-shot and periodic attention schedules");
	}
	const text = boundedText(data.text, "text", maximumPromptBytes);
	if (Buffer.byteLength(text, "utf8") > maximumPromptBytes) {
		throw new Error(`text must be at most ${maximumPromptBytes} UTF-8 bytes`);
	}
	const action = data.action === undefined ? undefined : boundedText(data.action, "action", 16);
	if (action && !["compact", "noop"].includes(action)) {
		throw new Error("action must be compact or noop");
	}
	if (action === "compact" && data.type !== "periodic") {
		throw new Error("compact is supported only for periodic schedules");
	}
	const delivery = {
		channelId: data.channelId === undefined ? "heartbeat" : boundedText(data.channelId, "channelId", 256),
		sourceEventType: boundedText(data.sourceEventType, "sourceEventType", 128, { optional: true }),
		replyTarget: boundedText(data.replyTarget, "replyTarget", 512, { optional: true }),
		replyTargetDescription: boundedText(data.replyTargetDescription, "replyTargetDescription", 512, { optional: true }),
		threadTs: boundedText(data.threadTs, "threadTs", 256, { optional: true }),
		...(data.followUp === undefined ? {} : { followUp: data.followUp }),
	};
	if (data.type === "one-shot") {
		const at = boundedText(data.at, "at", 64);
		if (!RFC3339_WITH_OFFSET.test(at)) throw new Error("at must be RFC3339 with an explicit offset");
		const atMs = Date.parse(at);
		if (!Number.isFinite(atMs)) throw new Error("at is not a valid timestamp");
		if (atMs - nowMs > maximumHorizonDays * 86_400_000) {
			throw new Error(`one-shot schedule exceeds the ${maximumHorizonDays}-day horizon`);
		}
		return {
			event: { type: "one-shot", text, at: iso(atMs), ...(action ? { action } : {}), ...delivery },
			kind: "one-shot",
			canonicalSlotAt: iso(atMs),
			nextFireAt: iso(atMs),
		};
	}

	const schedule = boundedText(data.schedule, "schedule", 256);
	const timezone = validateTimezone(data.timezone);
	const spontaneity = data.spontaneity === undefined ? 0 : data.spontaneity;
	if (typeof spontaneity !== "number" || !Number.isFinite(spontaneity) || spontaneity < 0 || spontaneity > 1) {
		throw new Error("spontaneity must be a number from 0 to 1");
	}
	const quietHours = validateQuietHours(data.quietHours);
	const event = {
		type: "periodic",
		text,
		schedule,
		timezone,
		...(spontaneity ? { spontaneity } : {}),
		...(quietHours ? { quietHours } : {}),
		...(action ? { action } : {}),
		...delivery,
	};
	let runs;
	try {
		runs = cronRuns(event, nowMs, 32);
	} catch {
		throw new Error("schedule must be valid cron syntax for the declared timezone");
	}
	if (runs.length < 2) throw new Error("periodic schedule does not have two future runs");
	for (let index = 1; index < runs.length; index++) {
		if (runs[index] - runs[index - 1] < minimumPeriodicSeconds * 1000) {
			throw new Error(`periodic schedule must remain at least ${minimumPeriodicSeconds} seconds apart`);
		}
	}
	const plan = planPeriodicOccurrence(event, {
		afterSlotMs: nowMs,
		deterministicKey,
	});
	if (!plan) throw new Error("periodic schedule has no future run");
	return {
		event,
		kind: "periodic",
		canonicalSlotAt: iso(plan.slotMs),
		nextFireAt: iso(plan.fireMs),
	};
}

export async function readBoundedScheduleFile(path, maximumFileBytes) {
	const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const information = await file.stat();
		if (!information.isFile()) throw new Error("schedule source must be a regular file");
		if (information.nlink !== 1) throw new Error("schedule source must have exactly one link");
		if (information.size > maximumFileBytes) {
			throw new Error(`schedule source exceeds ${maximumFileBytes} bytes`);
		}
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}

function occurrenceId(schedule, slotAt) {
	return `scheduled:${createHash("sha256")
		.update(`${schedule.contextId}\0${schedule.filename}\0${schedule.generation}\0${slotAt}`)
		.digest("hex")}`;
}

function selectedContexts(config, contexts) {
	const allowed = new Set(config.scheduledWakes.contextIds);
	if (config.scheduledWakes.mode === "host") {
		return contexts.filter((context) => allowed.has(context.id));
	}
	if (allowed.size > 0) return contexts.filter((context) => allowed.has(context.id));
	return contexts;
}

export class ScheduledWakeManager {
	constructor({ config, store, clock = () => Date.now() }) {
		this.config = config;
		this.store = store;
		this.clock = clock;
		this.scanning = false;
		this.scanCursor = 0;
	}

	async tick() {
		const settings = this.config.scheduledWakes;
		if (settings.mode === "off" || this.scanning) return { scanned: 0, materialized: 0 };
		this.scanning = true;
		try {
			const scan = await this.scan();
			if (settings.mode === "shadow") return { ...scan, materialized: 0 };
			const materialized = await this.materializeDue();
			return { ...scan, materialized };
		} finally {
			this.scanning = false;
		}
	}

	async scan() {
		let scanned = 0;
		const selected = selectedContexts(this.config, this.store.listContexts())
			.sort((left, right) => left.id.localeCompare(right.id));
		const limit = Math.min(selected.length, this.config.scheduledWakes.maximumContextsPerTick);
		const contexts = [];
		for (let index = 0; index < limit; index++) {
			contexts.push(selected[(this.scanCursor + index) % selected.length]);
		}
		if (selected.length > 0) this.scanCursor = (this.scanCursor + limit) % selected.length;
		for (const context of contexts) {
			const target = this.config.targetsById.get(context.targetId);
			if (!target) continue;
			let queueCustody;
			try {
				queueCustody = await openScheduleDirectory(target, context.id, "queue");
			} catch (error) {
				if (error?.code === "ENOENT") this.store.disarmMissingScheduledPrompts(context.id, []);
				else this.store.setMeta(`scheduled-wakes:scan-error:${context.id}`, String(error).slice(0, 1000));
				continue;
			}
			const queue = queueCustody.path;
			try {
			let names;
			try {
				names = (await readdir(queue)).filter((name) => extname(name) === ".json").sort();
			} catch (error) {
				this.store.setMeta(`scheduled-wakes:scan-error:${context.id}`, String(error).slice(0, 1000));
				continue;
			}
			if (names.length > this.config.scheduledWakes.maximumSchedulesPerContext) {
				this.store.disarmMissingScheduledPrompts(context.id, []);
				this.store.setMeta(
					`scheduled-wakes:scan-error:${context.id}`,
					`schedule count ${names.length} exceeds ${this.config.scheduledWakes.maximumSchedulesPerContext}`,
				);
				continue;
			}
			const seen = [];
			for (const name of names.slice(0, this.config.scheduledWakes.maximumScanFilesPerTick)) {
				if (!SAFE_FILENAME.test(name) || basename(name) !== name) continue;
				seen.push(name);
				const path = join(queue, name);
				try {
					const content = await readBoundedScheduleFile(path, this.config.scheduledWakes.maximumFileBytes);
					const sourceSha256 = createHash("sha256").update(content).digest("hex");
					const existing = this.store.getScheduledPrompt(context.id, name);
					const envelope = JSON.parse(content);
					if (envelope?.type === "immediate") {
						this.store.upsertScheduledPrompt({
							contextId: context.id,
							targetId: context.targetId,
							filename: name,
							sourceSha256,
							kind: "immediate",
							status: "runtime-owned",
							payload: {},
							canonicalSlotAt: null,
							nextFireAt: null,
						});
						scanned++;
						continue;
					}
					const generation = !existing
						? 1
						: existing.sourceSha256 === sourceSha256
							? existing.generation
							: existing.generation + 1;
					const parsed = parseHostScheduledEvent(content, {
						nowMs: this.clock(),
						maximumPromptBytes: this.config.scheduledWakes.maximumPromptBytes,
						minimumPeriodicSeconds: this.config.scheduledWakes.minimumPeriodicSeconds,
						maximumHorizonDays: this.config.scheduledWakes.maximumHorizonDays,
						deterministicKey: `${context.id}:${name}:${generation}`,
					});
					this.store.upsertScheduledPrompt({
						contextId: context.id,
						targetId: context.targetId,
						filename: name,
						sourceSha256,
						kind: parsed.kind,
						status: "armed",
						payload: parsed.event,
						canonicalSlotAt: parsed.canonicalSlotAt,
						nextFireAt: parsed.nextFireAt,
					});
					scanned++;
				} catch (error) {
					const sourceSha256 = createHash("sha256").update(`${name}:${String(error)}`).digest("hex");
					this.store.upsertScheduledPrompt({
						contextId: context.id,
						targetId: context.targetId,
						filename: name,
						sourceSha256,
						kind: "invalid",
						status: "invalid",
						payload: {},
						canonicalSlotAt: null,
						nextFireAt: null,
						lastError: error instanceof Error ? error.message : String(error),
					});
				}
			}
			// If a scan budget is hit, leave the unscanned indexed rows unchanged.
			if (names.length <= this.config.scheduledWakes.maximumScanFilesPerTick) {
				this.store.disarmMissingScheduledPrompts(context.id, seen);
			}
			this.store.setMeta(`scheduled-wakes:last-scan:${context.id}`, iso(this.clock()));
			this.store.setMeta(`scheduled-wakes:scan-error:${context.id}`, "");
			} finally {
				await queueCustody.close();
			}
		}
		return { scanned };
	}

	async materializeDue() {
		const settings = this.config.scheduledWakes;
		const due = this.store.listDueScheduledPrompts(
			iso(this.clock()),
			settings.maximumDuePerTick * 4,
			settings.contextIds,
		);
		const ownedContexts = new Set(settings.contextIds);
		const usedContexts = new Set();
		let materialized = 0;
		for (const schedule of due) {
			if (!ownedContexts.has(schedule.contextId)) continue;
			if (materialized >= settings.maximumDuePerTick || usedContexts.has(schedule.contextId)) continue;
			usedContexts.add(schedule.contextId);
			if (!(await this.sourceIsCurrent(schedule))) continue;
			const nowMs = this.clock();
			if (schedule.kind === "one-shot") {
				const lateMs = nowMs - Date.parse(schedule.nextFireAt);
				if (lateMs > settings.graceSeconds * 1000) {
					this.store.expireScheduledPrompt(schedule, "one-shot exceeded grace window");
					await this.archive(schedule, "expired");
					continue;
				}
				if (this.throttled(schedule, nowMs)) continue;
				const event = this.store.materializeScheduledPrompt({
					schedule,
					occurrenceId: occurrenceId(schedule, schedule.canonicalSlotAt),
					canonicalSlotAt: schedule.canonicalSlotAt,
					fireAt: schedule.nextFireAt,
					nextCanonicalSlotAt: null,
					nextFireAt: null,
					completeSchedule: true,
				});
				if (event) {
					materialized++;
					await this.archive(schedule, "fired");
				}
				continue;
			}
			if (schedule.kind !== "periodic") continue;
			const outcome = this.advancePeriodic(schedule, nowMs);
			if (!outcome.latestDue) {
				this.store.advanceScheduledPrompt(schedule, outcome.next);
				continue;
			}
			const lateMs = nowMs - outcome.latestDue.fireMs;
			if (lateMs > settings.graceSeconds * 1000) {
				this.store.advanceScheduledPrompt(schedule, outcome.next, "missed periodic slot exceeded grace window");
				continue;
			}
			if (this.throttled(schedule, nowMs)) continue;
			const event = this.store.materializeScheduledPrompt({
				schedule,
				occurrenceId: occurrenceId(schedule, iso(outcome.latestDue.slotMs)),
				canonicalSlotAt: iso(outcome.latestDue.slotMs),
				fireAt: iso(outcome.latestDue.fireMs),
				nextCanonicalSlotAt: iso(outcome.next.slotMs),
				nextFireAt: iso(outcome.next.fireMs),
				completeSchedule: false,
			});
			if (event) materialized++;
		}
		return materialized;
	}

	async sourceIsCurrent(schedule) {
		const target = this.config.targetsById.get(schedule.targetId);
		if (!target) {
			this.store.disarmScheduledPrompt(schedule, "scheduled target is unavailable");
			return false;
		}
		let queueCustody;
		try {
			queueCustody = await openScheduleDirectory(target, schedule.contextId, "queue");
		} catch (error) {
			if (error?.code === "ENOENT") {
				this.store.disarmScheduledPrompt(schedule, "source file is absent");
				return false;
			}
			this.store.noteScheduledPromptError(schedule, `source custody failed: ${String(error)}`);
			return false;
		}
		const source = join(queueCustody.path, schedule.filename);
		try {
			const content = await readBoundedScheduleFile(
				source,
				this.config.scheduledWakes.maximumFileBytes,
			);
			if (createHash("sha256").update(content).digest("hex") === schedule.sourceSha256) {
				return true;
			}
			this.store.noteScheduledPromptError(schedule, "source changed before materialization");
			return false;
		} catch (error) {
			if (error?.code === "ENOENT") {
				this.store.disarmScheduledPrompt(schedule, "source file is absent");
				return false;
			}
			this.store.noteScheduledPromptError(
				schedule,
				`source revalidation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		} finally {
			await queueCustody.close();
		}
	}

	advancePeriodic(schedule, nowMs) {
		const event = JSON.parse(schedule.payloadJson);
		let current = {
			slotMs: Date.parse(schedule.canonicalSlotAt),
			fireMs: Date.parse(schedule.nextFireAt),
		};
		let latestDue = null;
		for (let index = 0; index < this.config.scheduledWakes.maximumCatchUpSlots; index++) {
			if (current.fireMs > nowMs) return { latestDue, next: current };
			latestDue = current;
			const next = planPeriodicOccurrence(event, {
				afterSlotMs: current.slotMs,
				deterministicKey: `${schedule.contextId}:${schedule.filename}:${schedule.generation}`,
			});
			if (!next) throw new Error(`periodic schedule ${schedule.contextId}/${schedule.filename} has no next run`);
			current = next;
		}
		const next = planPeriodicOccurrence(event, {
			afterSlotMs: nowMs,
			deterministicKey: `${schedule.contextId}:${schedule.filename}:${schedule.generation}`,
		});
		if (!next) throw new Error(`periodic schedule ${schedule.contextId}/${schedule.filename} exhausted catch-up bound`);
		return { latestDue: null, next };
	}

	throttled(schedule, nowMs) {
		const since = iso(nowMs - 60 * 60 * 1000);
		if (this.store.countRecentScheduledEvents(schedule.contextId, since) < this.config.scheduledWakes.maximumOccurrencesPerHour) {
			return false;
		}
		this.store.noteScheduledPromptError(schedule, "hourly scheduled occurrence limit reached");
		return true;
	}

	async archive(schedule, outcome) {
		const target = this.config.targetsById.get(schedule.targetId);
		if (!target) return false;
		let queueCustody;
		let historyCustody;
		try {
			queueCustody = await openScheduleDirectory(target, schedule.contextId, "queue");
			historyCustody = await openScheduleDirectory(target, schedule.contextId, "history", { create: true });
		} catch (error) {
			await queueCustody?.close();
			this.store.noteScheduledPromptError(schedule, `archive custody failed: ${String(error)}`);
			return false;
		}
		const source = join(queueCustody.path, schedule.filename);
		const history = historyCustody.path;
		try {
			let content;
			try {
				content = await readBoundedScheduleFile(source, this.config.scheduledWakes.maximumFileBytes);
			} catch (error) {
				if (error?.code === "ENOENT") return false;
				this.store.noteScheduledPromptError(schedule, `archive read failed: ${String(error)}`);
				return false;
			}
			if (createHash("sha256").update(content).digest("hex") !== schedule.sourceSha256) return false;
			let data;
			try {
				data = JSON.parse(content);
			} catch {
				return false;
			}
			data._completedAt = iso(this.clock());
			data._outcome = outcome;
			let destination = join(history, schedule.filename);
			try {
				const existing = await open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
				await existing.close();
				const extension = extname(schedule.filename);
				destination = join(
					history,
					`${basename(schedule.filename, extension)}-${schedule.generation}${extension}`,
				);
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
			const temporary = join(history, `.${basename(destination)}.${process.pid}.tmp`);
			const output = await open(temporary, "wx", 0o600);
			try {
				await output.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
				await output.sync();
			} finally {
				await output.close();
			}
			await rename(temporary, destination);
			await unlink(source);
			await historyCustody.directory.sync();
			await queueCustody.directory.sync();
			this.store.markScheduledPromptArchived(schedule, outcome);
			return true;
		} finally {
			await historyCustody.close();
			await queueCustody.close();
		}
	}
}
