import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseHostScheduledEvent,
	planPeriodicOccurrence,
	readBoundedScheduleFile,
	ScheduledWakeManager,
} from "../src/scheduled-wakes.mjs";
import { contextWorkspacePath } from "../src/runtime.mjs";
import { HostStore } from "../src/store.mjs";

const BASE_NOW = Date.parse("2026-06-01T00:00:00.000Z");

function settings(overrides = {}) {
	return {
		mode: "shadow",
		contextIds: [],
		maximumContextsPerTick: 64,
		maximumSchedulesPerContext: 64,
		maximumScanFilesPerTick: 64,
		maximumFileBytes: 64 * 1024,
		maximumPromptBytes: 32 * 1024,
		minimumPeriodicSeconds: 300,
		maximumHorizonDays: 366,
		graceSeconds: 600,
		maximumDuePerTick: 4,
		maximumCatchUpSlots: 64,
		maximumOccurrencesPerHour: 12,
		...overrides,
	};
}

async function fixture(contextCount = 2, wakeSettings = settings()) {
	const directory = await mkdtemp(join(tmpdir(), "hostd-scheduled-wakes-"));
	const contextsDirectory = join(directory, "contexts");
	const target = { id: "front-desk", contextsDirectory };
	const statePath = join(directory, "state.sqlite");
	const store = new HostStore(statePath);
	const contexts = [];
	for (let index = 0; index < contextCount; index++) {
		const id = `front-desk:example-${index}:intake`;
		store.createContext({
			id,
			targetId: target.id,
			driver: "oci",
			runtimeName: `runtime-${index}`,
			port: 32000 + index,
		});
		const workspace = contextWorkspacePath(target, id);
		await mkdir(join(workspace, "attention", "queue"), { recursive: true });
		await mkdir(join(workspace, "attention", "history"), { recursive: true });
		contexts.push({ id, workspace });
	}
	const config = {
		scheduledWakes: wakeSettings,
		targetsById: new Map([[target.id, target]]),
	};
	return {
		directory,
		statePath,
		store,
		config,
		contexts,
		async write(contextIndex, filename, event) {
			await writeFile(
				join(contexts[contextIndex].workspace, "attention", "queue", filename),
				`${JSON.stringify(event, null, 2)}\n`,
				{ mode: 0o600 },
			);
		},
		async close() {
			store.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

function events(store) {
	return store.database.prepare(`
		SELECT id, source, context_id AS contextId, status, payload_json AS payloadJson
		FROM events WHERE source = 'scheduled-prompt' ORDER BY received_at, id
	`).all();
}

test("shadow indexes zero wakes before exact host ownership materializes one durable no-op", async () => {
	const subject = await fixture();
	let nowMs = BASE_NOW;
	await subject.write(0, "canary.json", {
		type: "one-shot",
		at: new Date(nowMs - 30_000).toISOString(),
		text: "exercise delivery without a model run",
		action: "noop",
	});
	await subject.write(1, "other.json", {
		type: "one-shot",
		at: new Date(nowMs - 30_000).toISOString(),
		text: "must remain isolated",
		action: "noop",
	});
	const manager = new ScheduledWakeManager({
		config: subject.config,
		store: subject.store,
		clock: () => nowMs,
	});
	try {
		assert.deepEqual(await manager.tick(), { scanned: 2, materialized: 0 });
		assert.equal(events(subject.store).length, 0);
		assert.equal(subject.store.status().armedScheduledPrompts, 2);

		subject.config.scheduledWakes.mode = "host";
		subject.config.scheduledWakes.contextIds = [subject.contexts[0].id];
		const result = await manager.tick();
		assert.equal(result.materialized, 1);
		const [event] = events(subject.store);
		assert.equal(event.contextId, subject.contexts[0].id);
		assert.equal(event.status, "queued");
		assert.equal(JSON.parse(event.payloadJson).event.action, "noop");
		assert.equal(subject.store.getScheduledPrompt(subject.contexts[0].id, "canary.json").status, "completed");
		assert.equal(subject.store.getScheduledPrompt(subject.contexts[1].id, "other.json").status, "armed");
		const archived = JSON.parse(await readFile(
			join(subject.contexts[0].workspace, "attention", "history", "canary.json"),
			"utf8",
		));
		assert.equal(archived._outcome, "fired");

		assert.equal((await manager.tick()).materialized, 0);
		assert.equal(events(subject.store).length, 1, "restart/tick retries cannot duplicate one occurrence");
	} finally {
		await subject.close();
	}
});

test("durable occurrence idempotency survives a Hostd database reopen", async () => {
	const subject = await fixture(1, settings({ mode: "host", contextIds: ["front-desk:example-0:intake"] }));
	let reopened;
	let originalClosed = false;
	try {
		await subject.write(0, "restart.json", {
			type: "one-shot",
			at: new Date(BASE_NOW).toISOString(),
			text: "exactly once",
			action: "noop",
		});
		const manager = new ScheduledWakeManager({ config: subject.config, store: subject.store, clock: () => BASE_NOW });
		assert.equal((await manager.tick()).materialized, 1);
		assert.equal(events(subject.store).length, 1);
		subject.store.close();
		originalClosed = true;
		reopened = new HostStore(subject.statePath);
		const restarted = new ScheduledWakeManager({ config: subject.config, store: reopened, clock: () => BASE_NOW });
		assert.equal((await restarted.tick()).materialized, 0);
		assert.equal(events(reopened).length, 1);
	} finally {
		if (!originalClosed) subject.store.close();
		reopened?.close();
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("source bytes are revalidated before materialization and changed files get a new generation", async () => {
	const subject = await fixture(1, settings({ mode: "host", contextIds: ["front-desk:example-0:intake"] }));
	let nowMs = BASE_NOW;
	const manager = new ScheduledWakeManager({ config: subject.config, store: subject.store, clock: () => nowMs });
	try {
		await subject.write(0, "mutable.json", {
			type: "one-shot",
			at: new Date(nowMs).toISOString(),
			text: "original",
			action: "noop",
		});
		await manager.scan();
		const first = subject.store.getScheduledPrompt(subject.contexts[0].id, "mutable.json");
		assert.equal(first.generation, 1);

		await subject.write(0, "mutable.json", {
			type: "one-shot",
			at: new Date(nowMs).toISOString(),
			text: "replacement",
			action: "noop",
		});
		assert.equal(await manager.materializeDue(), 0);
		assert.match(subject.store.getScheduledPrompt(subject.contexts[0].id, "mutable.json").lastError, /source changed/);
		assert.equal(events(subject.store).length, 0);

		await manager.scan();
		assert.equal(subject.store.getScheduledPrompt(subject.contexts[0].id, "mutable.json").generation, 2);
		assert.equal(await manager.materializeDue(), 1);
		assert.equal(JSON.parse(events(subject.store)[0].payloadJson).event.text, "replacement");
	} finally {
		await subject.close();
	}
});

test("periodic downtime coalesces to the newest eligible slot without a backlog storm", async () => {
	const subject = await fixture(1, settings({ mode: "host", contextIds: ["front-desk:example-0:intake"] }));
	let nowMs = BASE_NOW;
	const manager = new ScheduledWakeManager({ config: subject.config, store: subject.store, clock: () => nowMs });
	try {
		await subject.write(0, "periodic.json", {
			type: "periodic",
			schedule: "*/5 * * * *",
			timezone: "UTC",
			text: "bounded periodic check",
			action: "noop",
		});
		await manager.scan();
		nowMs = BASE_NOW + 16 * 60_000;
		assert.equal(await manager.materializeDue(), 1);
		const [event] = events(subject.store);
		const payload = JSON.parse(event.payloadJson);
		assert.equal(payload.schedule.canonicalSlotAt, "2026-06-01T00:15:00.000Z");
		const schedule = subject.store.getScheduledPrompt(subject.contexts[0].id, "periodic.json");
		assert.equal(schedule.canonicalSlotAt, "2026-06-01T00:20:00.000Z");
		assert.equal(events(subject.store).length, 1);
	} finally {
		await subject.close();
	}
});

test("catch-up and hourly limits skip excess periodic work", async () => {
	const subject = await fixture(1, settings({
		mode: "host",
		contextIds: ["front-desk:example-0:intake"],
		maximumCatchUpSlots: 2,
		maximumOccurrencesPerHour: 1,
	}));
	let nowMs = BASE_NOW;
	const manager = new ScheduledWakeManager({ config: subject.config, store: subject.store, clock: () => nowMs });
	try {
		await subject.write(0, "old-periodic.json", {
			type: "periodic", schedule: "*/5 * * * *", timezone: "UTC", text: "old", action: "noop",
		});
		await manager.scan();
		nowMs = BASE_NOW + 10 * 60 * 60_000;
		assert.equal(await manager.materializeDue(), 0, "excess backlog is skipped rather than replayed");
		assert(events(subject.store).length === 0);
		assert(Date.parse(subject.store.getScheduledPrompt(subject.contexts[0].id, "old-periodic.json").nextFireAt) > nowMs);

		await subject.write(0, "first.json", {
			type: "one-shot", at: new Date(nowMs).toISOString(), text: "first", action: "noop",
		});
		await subject.write(0, "second.json", {
			type: "one-shot", at: new Date(nowMs).toISOString(), text: "second", action: "noop",
		});
		await manager.scan();
		assert.equal(await manager.materializeDue(), 1);
		assert.equal(await manager.materializeDue(), 0);
		const remaining = subject.store.listDueScheduledPrompts(new Date(nowMs).toISOString(), 10)
			.find((schedule) => schedule.filename === "second.json" || schedule.filename === "first.json");
		assert.match(remaining.lastError, /hourly scheduled occurrence limit/);
	} finally {
		await subject.close();
	}
});

test("parsing, deterministic jitter, runtime-owned immediate files, and file custody fail closed", async () => {
	const periodic = JSON.stringify({
		type: "periodic",
		schedule: "0 * * * *",
		timezone: "UTC",
		spontaneity: 0.5,
		quietHours: { start: "23:00", end: "07:00" },
		text: "deterministic",
	});
	const first = parseHostScheduledEvent(periodic, { nowMs: BASE_NOW, deterministicKey: "example:1" });
	const second = parseHostScheduledEvent(periodic, { nowMs: BASE_NOW, deterministicKey: "example:1" });
	const laterScan = parseHostScheduledEvent(periodic, { nowMs: BASE_NOW + 30_000, deterministicKey: "example:1" });
	assert.deepEqual(first, second);
	assert.equal(laterScan.canonicalSlotAt, first.canonicalSlotAt);
	assert.equal(laterScan.nextFireAt, first.nextFireAt, "scan timing cannot alter generation-bound jitter");
	const highlyJittered = {
		type: "periodic", schedule: "*/5 * * * *", timezone: "UTC", text: "ordered", spontaneity: 1,
	};
	const orderedFirst = planPeriodicOccurrence(highlyJittered, { afterSlotMs: BASE_NOW, deterministicKey: "ordered:1" });
	const orderedSecond = planPeriodicOccurrence(highlyJittered, { afterSlotMs: orderedFirst.slotMs, deterministicKey: "ordered:1" });
	assert(orderedFirst.fireMs < orderedSecond.fireMs, "maximum jitter cannot reorder adjacent canonical slots");
	assert.throws(
		() => parseHostScheduledEvent(JSON.stringify({
			type: "one-shot", at: new Date(BASE_NOW).toISOString(), text: "🙂".repeat(20),
		}), { nowMs: BASE_NOW, maximumPromptBytes: 40 }),
		/UTF-8 bytes/,
	);
	assert.throws(
		() => parseHostScheduledEvent(JSON.stringify({
			type: "periodic", schedule: "* * * * *", timezone: "UTC", text: "too frequent",
		}), { nowMs: BASE_NOW, minimumPeriodicSeconds: 300 }),
		/at least 300 seconds apart/,
	);

	const subject = await fixture(1);
	try {
		await subject.write(0, "immediate.json", { type: "immediate", text: "runtime only" });
		const manager = new ScheduledWakeManager({ config: subject.config, store: subject.store, clock: () => BASE_NOW });
		assert.equal((await manager.tick()).materialized, 0);
		assert.equal(subject.store.getScheduledPrompt(subject.contexts[0].id, "immediate.json").status, "runtime-owned");
		assert.equal(events(subject.store).length, 0);

		const queue = join(subject.contexts[0].workspace, "attention", "queue");
		const real = join(queue, "real.json");
		await writeFile(real, "{}", { mode: 0o600 });
		await symlink(real, join(queue, "link.json"));
		await assert.rejects(readBoundedScheduleFile(join(queue, "link.json"), 1024), /ELOOP|symbolic link/i);
		await link(real, join(queue, "hard.json"));
		await assert.rejects(readBoundedScheduleFile(real, 1024), /exactly one link/);

		await rm(queue, { recursive: true, force: true });
		const escaped = join(subject.directory, "escaped-queue");
		await mkdir(escaped);
		await writeFile(join(escaped, "evil.json"), JSON.stringify({
			type: "one-shot", at: new Date(BASE_NOW).toISOString(), text: "must not index", action: "noop",
		}));
		await symlink(escaped, queue);
		assert.equal((await manager.scan()).scanned, 0);
		assert.equal(subject.store.getScheduledPrompt(subject.contexts[0].id, "evil.json"), undefined);
		assert.match(subject.store.getMeta(`scheduled-wakes:scan-error:${subject.contexts[0].id}`), /ELOOP|ENOTDIR|symbolic link/i);
	} finally {
		await subject.close();
	}
});
