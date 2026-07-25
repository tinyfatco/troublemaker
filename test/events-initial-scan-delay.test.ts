import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "../src/adapters/types.js";
import { EventsWatcher } from "../src/events.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const dir = mkdtempSync(join(tmpdir(), "events-delay-"));
	const eventsDir = join(dir, "events");
	let enqueued = 0;
	const adapter = {
		enqueueEvent() {
			enqueued++;
			return true;
		},
	} as unknown as PlatformAdapter;

	try {
		const watcher = new EventsWatcher(eventsDir, [adapter], { initialScanDelayMs: 50 });
		mkdirSync(eventsDir, { recursive: true });
		writeFileSync(join(eventsDir, "delayed.json"), JSON.stringify({
			type: "one-shot",
			at: new Date(Date.now() + 80).toISOString(),
			text: "delayed event",
		}));

		watcher.start();
		await sleep(10);
		assert.equal(enqueued, 0);

		await sleep(120);
		assert.equal(enqueued, 1);
		watcher.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
