import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventsWatcher, EventsWatcher } from "../src/events.js";
import type { MomEvent, PlatformAdapter } from "../src/adapters/types.js";

function fakeAdapter(onEvent: (event: MomEvent) => void): PlatformAdapter {
	return {
		name: "heartbeat",
		maxMessageLength: 100000,
		formatInstructions: "headless",
		start: async () => {}, stop: async () => {},
		postMessage: async () => "1", updateMessage: async () => {}, deleteMessage: async () => {},
		postInThread: async () => "1", uploadFile: async () => {},
		logToFile: () => {}, logBotResponse: () => {},
		getUser: () => undefined,
		getChannel: (id) => id === "heartbeat" ? { id, name: id } : undefined,
		getAllUsers: () => [], getAllChannels: () => [{ id: "heartbeat", name: "heartbeat" }],
		createContext: () => { throw new Error("not used"); },
		enqueueEvent(event) { onEvent(event); return event.channel === "heartbeat"; },
	};
}

async function waitFor(predicate: () => boolean, message: string) {
	for (let index = 0; index < 100; index++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

const directory = await mkdtemp(join(tmpdir(), "events-hostd-owner-"));
try {
	const standaloneDir = join(directory, "standalone");
	await mkdir(standaloneDir, { recursive: true });
	await writeFile(join(standaloneDir, "due.json"), JSON.stringify({
		type: "one-shot", text: "standalone due", at: new Date(Date.now() - 1_000).toISOString(),
	}));
	let standaloneRuns = 0;
	const standalone = new EventsWatcher(standaloneDir, [fakeAdapter(() => { standaloneRuns++; })], {
		historyDir: join(directory, "standalone-history"),
	});
	standalone.start();
	await waitFor(() => standaloneRuns === 1, "standalone one-shot behavior changed");
	standalone.stop();
	assert.equal(existsSync(join(standaloneDir, "due.json")), false);

	const workspace = join(directory, "hostd-workspace");
	const queue = join(workspace, "attention", "queue");
	const legacy = join(workspace, "events");
	await mkdir(queue, { recursive: true });
	await mkdir(legacy, { recursive: true });
	await writeFile(join(queue, "due.json"), JSON.stringify({
		type: "one-shot", text: "Hostd due", at: new Date(Date.now() - 1_000).toISOString(),
	}));
	await writeFile(join(legacy, "legacy.json"), JSON.stringify({
		type: "one-shot", text: "legacy due", at: new Date(Date.now() - 1_000).toISOString(),
	}));
	const texts: string[] = [];
	const owned = createEventsWatcher(workspace, [fakeAdapter((event) => texts.push(event.text))], {
		hostOwnsDelayedSchedules: true,
	});
	owned.start();
	await new Promise((resolve) => setTimeout(resolve, 25));
	await writeFile(join(queue, "immediate.json"), JSON.stringify({
		type: "immediate", text: "runtime immediate",
	}));
	await waitFor(() => texts.length === 2, "runtime-owned immediate and legacy events did not fire");
	owned.stop();
	assert(texts.some((text) => text.includes("runtime immediate")));
	assert(texts.some((text) => text.includes("legacy due")));
	assert.equal(existsSync(join(queue, "due.json")), true, "Hostd-owned one-shot source must remain queued");
} finally {
	await rm(directory, { recursive: true, force: true });
}

console.log("events Hostd ownership ok");
