import type { PlatformAdapter } from "../src/adapters/types.js";
import { withHostDeliveryScope } from "../src/adapters/host-delivery-scope.js";
import {
	createSendMessageTool,
	isObsoleteSilentControlMessage,
	normalizeDiscordChannel,
	resolveAdapter,
	resolveMessageTarget,
} from "../src/tools/send-message.js";
import { registerToolDisplayBarrier } from "../src/streaming/tool-delivery-barrier.js";

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
	const snowflake = "1234567890123456789";
	const telegramId = "1234567890";
	const discord = makeAdapter("discord");
	const telegram = makeAdapter("telegram");
	const slack = makeAdapter("slack");
	const email = makeAdapter("email");
	const phone = makeAdapter("phone");
	const mattermost = makeAdapter("mattermost");
	const rocketChat = makeAdapter("rocket-chat");
	const zulip = makeAdapter("zulip");
	const adapters = [telegram.adapter, discord.adapter, slack.adapter, mattermost.adapter, rocketChat.adapter, zulip.adapter, email.adapter, phone.adapter];

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
	const mattermostChannel = "mmmmmmmmmmmmmmmmmmmmmmmmmm";
	const mattermostRoot = "nnnnnnnnnnnnnnnnnnnnnnnnnn";
	const mattermostTarget = resolveMessageTarget(`mattermost:${mattermostChannel}:${mattermostRoot}`, adapters);
	assertEqual(mattermostTarget?.adapter.name, "mattermost", "mattermost target resolves to Mattermost adapter");
	assertEqual(mattermostTarget?.channel, mattermostChannel, "mattermost target preserves native channel ID");
	assertEqual(mattermostTarget?.threadTs, mattermostRoot, "mattermost thread target resolves root post ID");
	assertEqual(resolveMessageTarget(`mattermost:${mattermostChannel}`, adapters)?.threadTs, undefined, "mattermost channel target remains top-level");
	assertEqual(resolveMessageTarget(`mattermost:${mattermostChannel}:${mattermostRoot}`, [slack.adapter]), undefined, "mattermost target fails closed without Mattermost adapter");
	const rocketRoom = "rocketRoom123456";
	const rocketRoot = "rocketRoot654321";
	const rocketTarget = resolveMessageTarget(`rocket-chat:${rocketRoom}:${rocketRoot}`, adapters);
	assertEqual(rocketTarget?.adapter.name, "rocket-chat", "Rocket.Chat target resolves to Rocket.Chat adapter");
	assertEqual(rocketTarget?.channel, rocketRoom, "Rocket.Chat target preserves native room ID");
	assertEqual(rocketTarget?.threadTs, rocketRoot, "Rocket.Chat thread target resolves root message ID");
	assertEqual(resolveMessageTarget(`rocket-chat:${rocketRoom}`, adapters)?.threadTs, undefined, "Rocket.Chat room target remains top-level");
	assertEqual(resolveMessageTarget(`rocket-chat:${rocketRoom}:${rocketRoot}`, [slack.adapter]), undefined, "Rocket.Chat target fails closed without Rocket.Chat adapter");
	const zulipTarget = resolveMessageTarget("zulip:4", adapters);
	assertEqual(zulipTarget?.adapter.name, "zulip", "Zulip target resolves to Zulip adapter");
	assertEqual(zulipTarget?.channel, "4", "Zulip target preserves the numeric channel ID");
	const zulipDmTarget = resolveMessageTarget("zulip:dm:12,8", adapters);
	assertEqual(zulipDmTarget?.channel, "dm:8,12", "Zulip group DM target canonicalizes participant IDs");
	const zulipTopicTarget = resolveMessageTarget("zulip:4:topic:Road%20map%20%2F%20alpha", adapters);
	assertEqual(zulipTopicTarget?.channel, "4", "Zulip topic target preserves the channel ID");
	assertEqual(zulipTopicTarget?.threadTs, "Road map / alpha", "Zulip topic target decodes exact topic placement");
	assertEqual(resolveMessageTarget("zulip:4", [telegram.adapter]), undefined, "Zulip target never falls through to Telegram");
	assertEqual(resolveMessageTarget("email-thread:0123456789abcdef", adapters)?.adapter.name, "email", "email thread target resolves to Email adapter");
	assertEqual(resolveMessageTarget("email-thread:0123456789abcdef", adapters)?.channel, "email-thread:0123456789abcdef", "email thread target keeps thread channel for adapter resolution");
	assert(isObsoleteSilentControlMessage("[SILENT]"), "detects exact obsolete silent marker");
	assert(isObsoleteSilentControlMessage("  [silent]\n"), "detects whitespace/case variants of obsolete silent marker");
	assert(!isObsoleteSilentControlMessage("[SILENT] please log this"), "does not suppress normal text that merely mentions silent marker");

	const tool = createSendMessageTool(adapters);
	const deliveryOrder: string[] = [];
	let releaseDisplay!: () => void;
	const displayBarrier = new Promise<void>((resolve) => {
		releaseDisplay = () => {
			deliveryOrder.push("label");
			resolve();
		};
	});
	registerToolDisplayBarrier("call-ordered", displayBarrier);
	const originalPost = slack.adapter.postMessage;
	slack.adapter.postMessage = async (channel, text, attachments, subject) => {
		deliveryOrder.push("message");
		return originalPost.call(slack.adapter, channel, text, attachments, subject);
	};
	const orderedSend = (tool.execute as any)("call-ordered", {
		label: "announce deploy",
		target: "C1234567890",
		text: "deploy complete",
	});
	await Promise.resolve();
	assertEqual(deliveryOrder.length, 0, "send_message waits while its visible tool label is pending");
	releaseDisplay();
	await orderedSend;
	assertEqual(deliveryOrder.join(","), "label,message", "visible tool label completes before external message delivery");

	const result = await (tool.execute as any)("call-1", {
		label: "discord test",
		target: `discord:${snowflake}`,
		text: "hello discord",
	});

	assertEqual(discord.sent.length, 1, "tool sends prefixed Discord target through Discord adapter");
	assertEqual(discord.sent[0]?.channel, snowflake, "tool passes raw snowflake to Discord postMessage");
	assertEqual(telegram.sent.length, 0, "tool does not fall through to Telegram for Discord snowflake");
	assert((result.content?.[0]?.text || "").includes(`discord target discord:${snowflake}`), "tool result names the requested target");
	assertEqual(result.details?.delivered, true, "successful tool result exposes a stable delivered marker");

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

	await (tool.execute as any)("call-mattermost-thread", {
		label: "mattermost thread test",
		target: `mattermost:${mattermostChannel}:${mattermostRoot}`,
		text: "hello mattermost thread",
	});
	assertEqual(mattermost.threadSent.length, 1, "tool sends Mattermost thread targets through postInThread");
	assertEqual(mattermost.threadSent[0]?.channel, mattermostChannel, "Mattermost thread target passes native channel");
	assertEqual(mattermost.threadSent[0]?.threadTs, mattermostRoot, "Mattermost thread target passes root post ID");

	await (tool.execute as any)("call-rocket-thread", {
		label: "Rocket.Chat thread test",
		target: `rocket-chat:${rocketRoom}:${rocketRoot}`,
		text: "hello Rocket.Chat relationship thread",
	});
	assertEqual(rocketChat.threadSent.length, 1, "tool sends Rocket.Chat thread targets through postInThread");
	assertEqual(rocketChat.threadSent[0]?.channel, rocketRoom, "Rocket.Chat thread target passes native room");
	assertEqual(rocketChat.threadSent[0]?.threadTs, rocketRoot, "Rocket.Chat thread target passes root message ID");

	await (tool.execute as any)("call-zulip-channel", {
		label: "Zulip channel test",
		target: "zulip:4",
		text: "hello Zulip crew",
	});
	assertEqual(zulip.sent.length, 1, "tool sends explicit Zulip targets through the Zulip adapter");
	assertEqual(zulip.sent[0]?.channel, "4", "Zulip target passes the native channel ID");
	await (tool.execute as any)("call-zulip-dm", {
		label: "Zulip DM test",
		target: "zulip:dm:8",
		text: "hello Zulip DM",
	});
	assertEqual(zulip.sent[1]?.channel, "dm:8", "tool sends Zulip DMs through the direct conversation key");
	await (tool.execute as any)("call-zulip-topic", {
		label: "Zulip topic test",
		target: "zulip:4:topic:Road%20map%20%2F%20alpha",
		text: "hello Zulip topic",
	});
	assertEqual(zulip.threadSent[0]?.channel, "4", "tool sends Zulip topic replies to the native channel");
	assertEqual(zulip.threadSent[0]?.threadTs, "Road map / alpha", "tool preserves exact Zulip topic placement");

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

	const relationshipTarget = "phone-relationship-bound";
	await withHostDeliveryScope({
		source: "mcp-operator",
		eventId: "00000000-0000-4000-8000-000000000001",
		replyTarget: relationshipTarget,
	}, async () => {
		await (tool.execute as any)("call-relationship-exact", {
			label: "bounded relationship reply",
			target: relationshipTarget,
			text: "one exact relationship reply",
		});
		assertEqual(phone.sent.at(-1)?.channel, relationshipTarget, "MCP relationship turn permits the exact Hostd-bound target");
		try {
			await (tool.execute as any)("call-relationship-substitute", {
				label: "wrong relationship reply",
				target: "zulip:4",
				text: "must not leave the relationship",
			});
			assert(false, "MCP relationship turn denies another channel target");
		} catch (error) {
			assert(error instanceof Error && error.message.includes("exact bound reply target"), "MCP relationship turn denies another channel target");
		}
		try {
			await (tool.execute as any)("call-relationship-group", {
				label: "wrong group reply",
				target: relationshipTarget,
				text: "must remain direct",
				recipients: ["+15555550124"],
			});
			assert(false, "MCP relationship turn denies recipient expansion");
		} catch (error) {
			assert(error instanceof Error && error.message.includes("direct plain-text"), "MCP relationship turn denies recipient expansion");
		}
	});

	const silentResult = await (tool.execute as any)("call-2", {
		label: "legacy silent",
		target: telegramId,
		text: "[SILENT]",
	});

	assertEqual(telegram.sent.length, 0, "tool suppresses obsolete silent marker before Telegram send");
	assert((silentResult.content?.[0]?.text || "").includes("Suppressed obsolete [SILENT]"), "tool result explains silent suppression");
	assertEqual(silentResult.details?.delivered, false, "suppressed control messages are not marked delivered");

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
	console.error("Test error:", err);
	process.exit(1);
});
