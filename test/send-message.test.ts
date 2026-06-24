import type { PlatformAdapter } from "../src/adapters/types.js";
import {
	createSendMessageTool,
	isObsoleteSilentControlMessage,
	normalizeDiscordChannel,
	resolveAdapter,
	resolveMessageTarget,
} from "../src/tools/send-message.js";

type SentMessage = { channel: string; text: string };
type ThreadMessage = { channel: string; threadTs: string; text: string };
type GroupMessage = { channel: string; text: string; recipients: string[] };

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
	const threadSent: ThreadMessage[] = [];
	const groupSent: GroupMessage[] = [];
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
		postInThread: async (channel: string, threadTs: string, text: string) => {
			threadSent.push({ channel, threadTs, text });
			return `${name}-thread-ts`;
		},
		postMessageToRecipients: async (channel: string, text: string, recipients: string[]) => {
			groupSent.push({ channel, text, recipients });
			return `${name}-group-ts`;
		},
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
	return { adapter, sent, threadSent, groupSent };
}

async function run() {
	const snowflake = "1443881334165733493";
	const telegramId = "1234567890";
	const discord = makeAdapter("discord");
	const telegram = makeAdapter("telegram");
	const slack = makeAdapter("slack");
	const email = makeAdapter("email");
	const phone = makeAdapter("phone");
	const adapters = [telegram.adapter, discord.adapter, slack.adapter, email.adapter, phone.adapter];

	assertEqual(normalizeDiscordChannel(`discord:${snowflake}`), snowflake, "normalizes discord: snowflake");
	assertEqual(normalizeDiscordChannel(`discord-${snowflake}`), snowflake, "normalizes discord- snowflake");
	assertEqual(normalizeDiscordChannel(snowflake), snowflake, "normalizes raw Discord snowflake");
	assertEqual(normalizeDiscordChannel(telegramId), undefined, "does not treat shorter numeric IDs as Discord");

	const rawTarget = resolveMessageTarget(snowflake, adapters);
	assertEqual(rawTarget?.adapter.name, "discord", "raw snowflake resolves to Discord before Telegram");
	assertEqual(rawTarget?.channel, snowflake, "raw snowflake keeps raw Discord channel ID");

	const prefixedTarget = resolveMessageTarget(`discord-${snowflake}`, adapters);
	assertEqual(prefixedTarget?.adapter.name, "discord", "discord- target resolves to Discord");
	assertEqual(prefixedTarget?.channel, snowflake, "discord- target strips prefix before send");

	assertEqual(resolveAdapter(telegramId, adapters)?.name, "telegram", "shorter numeric ID still resolves to Telegram");
	assertEqual(resolveMessageTarget(`discord:${snowflake}`, [telegram.adapter]), undefined, "discord target fails closed without Discord adapter");
	assertEqual(resolveMessageTarget("slack:C1234567890:1710000000.123456", adapters)?.threadTs, "1710000000.123456", "slack thread target resolves thread timestamp");
	assertEqual(resolveMessageTarget("email-thread:0123456789abcdef", adapters)?.adapter.name, "email", "email thread target resolves to Email adapter");
	assertEqual(resolveMessageTarget("email-thread:0123456789abcdef", adapters)?.channel, "email-thread:0123456789abcdef", "email thread target keeps thread channel for adapter resolution");
	assert(isObsoleteSilentControlMessage("[SILENT]"), "detects exact obsolete silent marker");
	assert(isObsoleteSilentControlMessage("  [silent]\n"), "detects whitespace/case variants of obsolete silent marker");
	assert(!isObsoleteSilentControlMessage("[SILENT] please log this"), "does not suppress normal text that merely mentions silent marker");

	const tool = createSendMessageTool(adapters);
	const result = await (tool.execute as any)("call-1", {
		label: "discord test",
		target: `discord:${snowflake}`,
		text: "hello discord",
	});

	assertEqual(discord.sent.length, 1, "tool sends prefixed Discord target through Discord adapter");
	assertEqual(discord.sent[0]?.channel, snowflake, "tool passes raw snowflake to Discord postMessage");
	assertEqual(telegram.sent.length, 0, "tool does not fall through to Telegram for Discord snowflake");
	assert((result.content?.[0]?.text || "").includes(`discord target discord:${snowflake}`), "tool result names the requested target");

	try {
		await (tool.execute as any)("call-missing-target", {
			label: "missing target",
			text: "where should this go?",
		});
		assert(false, "tool fails clearly when target is omitted");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("send_message requires a target"), "tool fails clearly when target is omitted");
	}

	await (tool.execute as any)("call-thread", {
		label: "slack thread test",
		target: "slack:C1234567890:1710000000.123456",
		text: "hello thread",
	});
	assertEqual(slack.threadSent.length, 1, "tool sends slack thread targets through postInThread");
	assertEqual(slack.threadSent[0]?.channel, "C1234567890", "slack thread target passes raw channel");
	assertEqual(slack.threadSent[0]?.threadTs, "1710000000.123456", "slack thread target passes thread timestamp");

	await (tool.execute as any)("call-email-thread", {
		label: "email thread test",
		target: "email-thread:0123456789abcdef",
		text: "hello email thread",
	});
	assertEqual(email.sent.length, 1, "tool sends email-thread targets through Email postMessage");
	assertEqual(email.sent[0]?.channel, "email-thread:0123456789abcdef", "email thread target passes through to Email adapter");

	await (tool.execute as any)("call-phone-group", {
		label: "phone group test",
		target: "phone-abc123",
		text: "hello phone group",
		recipients: ["+15555550124", "+15555550124", " +15555550125 "],
	});
	assertEqual(phone.groupSent.length, 1, "tool sends phone targets with explicit recipients through group-aware phone method");
	assertEqual(phone.groupSent[0]?.channel, "phone-abc123", "phone group target preserves phone channel");
	assertEqual(phone.groupSent[0]?.recipients.join(","), "+15555550124,+15555550125", "phone group recipients are trimmed and deduped");

	const silentResult = await (tool.execute as any)("call-2", {
		label: "legacy silent",
		target: telegramId,
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
