import type { PlatformAdapter } from "../src/adapters/types.js";
import {
	createSendMessageToChannelTool,
	isObsoleteSilentControlMessage,
	normalizeDiscordChannel,
	resolveAdapter,
	resolveChannelTarget,
} from "../src/tools/send-message-to-channel.js";

type SentMessage = { channel: string; text: string };

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

function assertEqual<T>(actual: T, expected: T, msg: string) {
	assert(actual === expected, `${msg} (got ${String(actual)}, expected ${String(expected)})`);
}

function makeAdapter(name: string) {
	const sent: SentMessage[] = [];
	const adapter = {
		name,
		maxMessageLength: 1000,
		formatInstructions: "",
		start: async () => {},
		stop: async () => {},
		postMessage: async (channel: string, text: string) => {
			sent.push({ channel, text });
			return `${name}-ts`;
		},
		updateMessage: async () => {},
		deleteMessage: async () => {},
		postInThread: async () => `${name}-thread-ts`,
		uploadFile: async () => {},
		logToFile: () => {},
		logBotResponse: () => {},
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllUsers: () => [],
		getAllChannels: () => [],
		createContext: () => {
			throw new Error("not needed in this test");
		},
		enqueueEvent: () => false,
	} as unknown as PlatformAdapter;
	return { adapter, sent };
}

async function run() {
	const snowflake = "1443881334165733493";
	const telegramId = "1234567890";
	const discord = makeAdapter("discord");
	const telegram = makeAdapter("telegram");
	const slack = makeAdapter("slack");
	const adapters = [telegram.adapter, discord.adapter, slack.adapter];

	assertEqual(normalizeDiscordChannel(`discord:${snowflake}`), snowflake, "normalizes discord: snowflake");
	assertEqual(normalizeDiscordChannel(`discord-${snowflake}`), snowflake, "normalizes discord- snowflake");
	assertEqual(normalizeDiscordChannel(snowflake), snowflake, "normalizes raw Discord snowflake");
	assertEqual(normalizeDiscordChannel(telegramId), undefined, "does not treat shorter numeric IDs as Discord");

	const rawTarget = resolveChannelTarget(snowflake, adapters);
	assertEqual(rawTarget?.adapter.name, "discord", "raw snowflake resolves to Discord before Telegram");
	assertEqual(rawTarget?.channel, snowflake, "raw snowflake keeps raw Discord channel ID");

	const prefixedTarget = resolveChannelTarget(`discord-${snowflake}`, adapters);
	assertEqual(prefixedTarget?.adapter.name, "discord", "discord- target resolves to Discord");
	assertEqual(prefixedTarget?.channel, snowflake, "discord- target strips prefix before send");

	assertEqual(resolveAdapter(telegramId, adapters)?.name, "telegram", "shorter numeric ID still resolves to Telegram");
	assertEqual(resolveChannelTarget(`discord:${snowflake}`, [telegram.adapter]), undefined, "discord target fails closed without Discord adapter");
	assert(isObsoleteSilentControlMessage("[SILENT]"), "detects exact obsolete silent marker");
	assert(isObsoleteSilentControlMessage("  [silent]\n"), "detects whitespace/case variants of obsolete silent marker");
	assert(!isObsoleteSilentControlMessage("[SILENT] please log this"), "does not suppress normal text that merely mentions silent marker");

	const tool = createSendMessageToChannelTool(adapters);
	const result = await (tool.execute as any)("call-1", {
		label: "discord test",
		channel: `discord:${snowflake}`,
		text: "hello discord",
	});

	assertEqual(discord.sent.length, 1, "tool sends prefixed Discord target through Discord adapter");
	assertEqual(discord.sent[0]?.channel, snowflake, "tool passes raw snowflake to Discord postMessage");
	assertEqual(telegram.sent.length, 0, "tool does not fall through to Telegram for Discord snowflake");
	assert((result.content?.[0]?.text || "").includes(`discord channel ${snowflake}`), "tool result names normalized Discord channel");

	const silentResult = await (tool.execute as any)("call-2", {
		label: "legacy silent",
		channel: telegramId,
		text: "[SILENT]",
	});

	assertEqual(telegram.sent.length, 0, "tool suppresses obsolete silent marker before Telegram send");
	assert((silentResult.content?.[0]?.text || "").includes("Suppressed obsolete [SILENT]"), "tool result explains silent suppression");

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
	console.error("Test error:", err);
	process.exit(1);
});
