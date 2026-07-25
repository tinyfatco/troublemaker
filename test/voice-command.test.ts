import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlashCommand } from "../src/commands.js";
import type { MomContext, MomEvent, PlatformAdapter } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

function makeAdapter(posts: string[]): PlatformAdapter {
	return {
		name: "web",
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
	const workingDir = mkdtempSync(join(tmpdir(), "tm-voice-command-"));
	try {
		const posts: string[] = [];
		const adapter = makeAdapter(posts);
		const settingsPath = join(workingDir, "settings.json");

		let handled = await handleSlashCommand("/voice", "web", workingDir, adapter);
		assert.equal(handled, true, "/voice is handled");
		assert.match(posts.at(-1) || "", /Realtime voices:/, "/voice lists available voices");
		assert.match(posts.at(-1) || "", /`marin`/, "/voice includes marin");
		assert.match(posts.at(-1) || "", /`cedar`/, "/voice includes cedar");
		assert.match(posts.at(-1) || "", /current\s+`marin`/, "/voice marks marin as the default current voice");
		assert.equal(existsSync(settingsPath), false, "listing voices does not create settings.json");

		writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "fireworks" }), "utf-8");
		handled = await handleSlashCommand("/voice cedar", "web", workingDir, adapter);
		assert.equal(handled, true, "/voice <name> is handled");
		assert.match(posts.at(-1) || "", /Switched Realtime voice to \*cedar\*/, "/voice confirms selection");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		assert.equal(settings.defaultProvider, "fireworks", "/voice preserves existing settings");
		assert.equal(settings.realtimeVoice, "cedar", "/voice writes realtimeVoice");

		posts.length = 0;
		await handleSlashCommand("/voice nope", "web", workingDir, adapter);
		assert.match(posts.at(-1) || "", /Unknown voice: "nope"/, "/voice rejects unknown voices");
		const afterInvalid = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		assert.equal(afterInvalid.realtimeVoice, "cedar", "invalid /voice does not change the setting");

		posts.length = 0;
		await handleSlashCommand("/voice list", "web", workingDir, adapter);
		assert.match(posts.at(-1) || "", /current\s+`cedar`/, "/voice list marks configured current voice");

		console.log("voice-command ok");
	} finally {
		rmSync(workingDir, { recursive: true, force: true });
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
