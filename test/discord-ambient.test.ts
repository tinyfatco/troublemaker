import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ChannelPulse } from "../src/engagement/channel-pulse.js";
import { DiscordWebhookAdapter } from "../src/adapters/discord-webhook.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

function makeHandler() {
	const handled: MomEvent[] = [];
	const handler: MomHandler = {
		isRunning: () => false,
		handleEvent: async (event) => {
			handled.push(event);
		},
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
	return { handler, handled };
}

async function flushQueue() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function run() {
	const workingDir = mkdtempSync(join(tmpdir(), "discord-ambient-"));
	try {
		const pulse = new ChannelPulse("pending");
		const ambientEvents: MomEvent[] = [];
		let ambientOrigin: unknown;
		const { handler, handled } = makeHandler();
		const adapter = new DiscordWebhookAdapter({
			botToken: "test-token",
			applicationId: "1504644609433800876",
			publicKey: "00".repeat(32),
			workingDir,
			pulse,
			onAmbientMessage: (_channelId, event, origin) => {
				ambientOrigin = origin;
				ambientEvents.push(event);
			},
		});
		adapter.setHandler(handler);

		await adapter.handleGatewayMessage({
			type: "message",
			trigger: "ambient",
			channelId: "1443881334165733493",
			channelName: "general",
			guildId: "1443881334165733490",
			author: { id: "1443881334165733499", username: "alex", global_name: "Alex" },
			content: "ordinary channel chatter",
			rawContent: "ordinary channel chatter",
			messageId: "1443881334165733501",
			isDM: false,
			isMentioned: false,
			timestamp: new Date().toISOString(),
			botUserId: "1504644609433800876",
		});

		assert(ambientEvents.length === 1, "ambient Discord message schedules ambient engagement");
		assert(ambientOrigin === adapter, "ambient Discord message preserves its receiving adapter");
		assert(handled.length === 0, "ambient Discord message does not start a direct run");
		assert(pulse.recentMessages("1443881334165733493").length === 1, "ambient Discord message records channel pulse");
		assert(adapter.getChannel("1443881334165733493")?.name === "general", "ambient Discord message tracks channel metadata");
		assert(adapter.getUser("1443881334165733499")?.displayName === "Alex", "ambient Discord message tracks user metadata");

		await adapter.handleGatewayMessage({
			type: "message",
			trigger: "mention",
			channelId: "1443881334165733493",
			channelName: "general",
			guildId: "1443881334165733490",
			author: { id: "1443881334165733499", username: "alex", global_name: "Alex" },
			content: "<@1504644609433800876> please respond",
			rawContent: "<@1504644609433800876> please respond",
			messageId: "1443881334165733502",
			isDM: false,
			isMentioned: true,
			timestamp: new Date().toISOString(),
			botUserId: "1504644609433800876",
		});
		await flushQueue();

		assert(handled.length === 1, "mentioned Discord message starts a normal run");
		assert(handled[0]?.text === "please respond", "mentioned Discord message strips bot mention");

		adapter.logBotResponse("1443881334165733493", "agent reply", "1443881334165733503");
		assert(pulse.summary("1443881334165733493").timeSinceMyLastMs < 1000, "Discord bot replies update pulse self timing");

		console.log(`\n${passed} passed, ${failed} failed`);
		process.exit(failed > 0 ? 1 : 0);
	} finally {
		rmSync(workingDir, { recursive: true, force: true });
	}
}

run().catch((err) => {
	console.error("Test error:", err);
	process.exit(1);
});
