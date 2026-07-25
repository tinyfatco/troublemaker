import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cron } from "croner";
import type { PlatformAdapter } from "../src/adapters/types.js";
import { EventsWatcher } from "../src/events.js";

type InspectableEventsWatcher = {
	watcher: { close(): void } | null;
	knownFiles: Set<string>;
	crons: Map<string, Cron>;
	scanExistingAsync(): Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function periodicEvent(text: string) {
	return JSON.stringify({
		type: "periodic",
		text,
		schedule: "0 0 1 1 *",
		timezone: "UTC",
	});
}

function disableFsWatch(watcher: EventsWatcher): InspectableEventsWatcher {
	const inspectable = watcher as unknown as InspectableEventsWatcher;
	inspectable.watcher?.close();
	inspectable.watcher = null;
	return inspectable;
}

async function testScanReconcilesRemovedFiles(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "events-reconcile-"));
	const filename = "removed-periodic.json";
	const filePath = join(dir, filename);
	const adapter = { enqueueEvent: () => true } as unknown as PlatformAdapter;
	const watcher = new EventsWatcher(dir, [adapter]);

	try {
		writeFileSync(filePath, periodicEvent("must not fire"));
		watcher.start();
		const inspectable = watcher as unknown as InspectableEventsWatcher;
		await waitFor(() => inspectable.crons.has(filename), "periodic schedule to load");

		disableFsWatch(watcher);
		unlinkSync(filePath);
		await inspectable.scanExistingAsync();

		assert.equal(inspectable.knownFiles.has(filename), false);
		assert.equal(inspectable.crons.has(filename), false);
	} finally {
		watcher.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function testPeriodicFireRevalidatesMissingSource(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "events-prefire-missing-"));
	const filename = "missing-periodic.json";
	const filePath = join(dir, filename);
	const enqueued: string[] = [];
	const adapter = {
		enqueueEvent(event: { text: string }) {
			enqueued.push(event.text);
			return true;
		},
	} as unknown as PlatformAdapter;
	const watcher = new EventsWatcher(dir, [adapter]);

	try {
		writeFileSync(filePath, periodicEvent("deleted source"));
		watcher.start();
		const inspectable = watcher as unknown as InspectableEventsWatcher;
		await waitFor(() => inspectable.crons.has(filename), "periodic schedule to load");
		const loadedCron = inspectable.crons.get(filename);
		assert(loadedCron);

		disableFsWatch(watcher);
		unlinkSync(filePath);
		await loadedCron.trigger();

		assert.deepEqual(enqueued, []);
		assert.equal(inspectable.knownFiles.has(filename), false);
		assert.equal(inspectable.crons.has(filename), false);
	} finally {
		watcher.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function testPeriodicFireReloadsValidReplacementWithoutRunningStaleEvent(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "events-prefire-replaced-"));
	const filename = "changed-periodic.json";
	const filePath = join(dir, filename);
	const enqueued: string[] = [];
	const adapter = {
		enqueueEvent(event: { text: string }) {
			enqueued.push(event.text);
			return true;
		},
	} as unknown as PlatformAdapter;
	const watcher = new EventsWatcher(dir, [adapter]);

	try {
		writeFileSync(filePath, periodicEvent("old text"));
		watcher.start();
		const inspectable = watcher as unknown as InspectableEventsWatcher;
		await waitFor(() => inspectable.crons.has(filename), "original periodic schedule to load");
		const loadedCron = inspectable.crons.get(filename);
		assert(loadedCron);

		disableFsWatch(watcher);
		writeFileSync(filePath, periodicEvent("new text"));
		await loadedCron.trigger();

		assert.deepEqual(enqueued, []);
		await waitFor(
			() => inspectable.crons.has(filename) && inspectable.crons.get(filename) !== loadedCron,
			"replacement periodic schedule to load",
		);
		const replacementCron = inspectable.crons.get(filename);
		assert(replacementCron);
		await replacementCron.trigger();
		assert.equal(enqueued.length, 1);
		assert.match(enqueued[0], /new text/);
		assert.doesNotMatch(enqueued[0], /old text/);
	} finally {
		watcher.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function testPeriodicFireRejectsInvalidReplacement(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "events-prefire-invalid-"));
	const filename = "replaced-periodic.json";
	const filePath = join(dir, filename);
	let enqueued = 0;
	const adapter = {
		enqueueEvent() {
			enqueued++;
			return true;
		},
	} as unknown as PlatformAdapter;
	const watcher = new EventsWatcher(dir, [adapter]);

	try {
		writeFileSync(filePath, periodicEvent("stale loaded source"));
		watcher.start();
		const inspectable = watcher as unknown as InspectableEventsWatcher;
		await waitFor(() => inspectable.crons.has(filename), "periodic schedule to load");
		const loadedCron = inspectable.crons.get(filename);
		assert(loadedCron);

		disableFsWatch(watcher);
		writeFileSync(filePath, "STOPPED\n");
		await loadedCron.trigger();

		assert.equal(enqueued, 0);
		assert.equal(inspectable.knownFiles.has(filename), false);
		assert.equal(inspectable.crons.has(filename), false);
	} finally {
		watcher.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

await testScanReconcilesRemovedFiles();
await testPeriodicFireRevalidatesMissingSource();
await testPeriodicFireReloadsValidReplacementWithoutRunningStaleEvent();
await testPeriodicFireRejectsInvalidReplacement();
console.log("events source-revalidation tests passed");
