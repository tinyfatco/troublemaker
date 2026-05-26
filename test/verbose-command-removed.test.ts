import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlashCommand } from "../src/commands.js";
import type { MomContext, MomEvent, PlatformAdapter } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

function makeAdapter(posts: string[]): PlatformAdapter {
	return {
		name: "slack",
		maxMessageLength: 40000,
		formatInstructions: "",
		start: async () => {},
		stop: async () => {},
		postMessage: async (_channel: string, text: string) => {
			posts.push(text);
			return `post-${posts.length}`;
		},
		updateMessage: async () => {},
		deleteMessage: async () => {},
		postInThread: async () => `thread-${posts.length}`,
		uploadFile: async () => {},
		logToFile: () => {},
		logBotResponse: () => {},
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllUsers: () => [],
		getAllChannels: () => [],
		createContext: (_event: MomEvent, _store: ChannelStore): MomContext => {
			throw new Error("not needed in this test");
		},
		enqueueEvent: () => false,
	};
}

async function run() {
	const workingDir = mkdtempSync(join(tmpdir(), "tm-verbose-removed-"));
	try {
		const posts: string[] = [];
		const handled = await handleSlashCommand("/verbose", "C1234567890", workingDir, makeAdapter(posts));
		assert.equal(handled, false, "/verbose is not a slash command");
		assert.deepEqual(posts, [], "/verbose does not emit a command response");
		console.log("verbose-command-removed ok");
	} finally {
		rmSync(workingDir, { recursive: true, force: true });
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
