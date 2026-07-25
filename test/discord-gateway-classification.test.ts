import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyDiscordMessageCreate,
	DiscordGatewayAdapter,
	type DiscordMessageCreate,
} from "../src/adapters/discord-gateway.js";
import type { DiscordGatewayMessagePayload } from "../src/adapters/discord-base.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import { ChannelPulse } from "../src/engagement/channel-pulse.js";

// Synthetic Discord-shaped fixtures; none identify a real account or deployment.
const BOT_ID = "100000000000000001";
const USER_ID = "200000000000000002";
const OTHER_USER_ID = "200000000000000003";
const DISALLOWED_USER_ID = "200000000000000004";
const GUILD_ID = "300000000000000003";
const OTHER_GUILD_ID = "300000000000000004";
const GUILD_CHANNEL_ID = "400000000000000004";
const DM_CHANNEL_ID = "400000000000000005";
const OTHER_CHANNEL_ID = "400000000000000006";
const UNAUTHORIZED_DM_CHANNEL_ID = "400000000000000007";
const MESSAGE_ID = "500000000000000005";
const BOT_MESSAGE_ID = "500000000000000006";

function message(overrides: Partial<DiscordMessageCreate> = {}): DiscordMessageCreate {
	return {
		id: MESSAGE_ID,
		channel_id: GUILD_CHANNEL_ID,
		guild_id: GUILD_ID,
		content: "hello",
		type: 0,
		author: { id: USER_ID, username: "sample-user", global_name: "Sample User" },
		...overrides,
	};
}

const classificationOptions = {
	botUserId: BOT_ID,
	allowAmbientGuildMessages: false,
};

assert.equal(classifyDiscordMessageCreate(message(), classificationOptions), null, "ordinary guild chatter is closed by default");
assert.equal(classifyDiscordMessageCreate(message({
	content: `<@${BOT_ID}> hello`,
	mentions: [{ id: BOT_ID }],
}), classificationOptions)?.trigger, "mention");
assert.equal(classifyDiscordMessageCreate(message({ guild_id: undefined, channel_id: DM_CHANNEL_ID }), classificationOptions)?.trigger, "dm");
assert.equal(classifyDiscordMessageCreate(message({
	type: 19,
	message_reference: { message_id: BOT_MESSAGE_ID },
	referenced_message: { id: BOT_MESSAGE_ID, author: { id: BOT_ID, bot: true } },
}), classificationOptions)?.trigger, "reply");
assert.equal(classifyDiscordMessageCreate(message({
	type: 19,
	message_reference: { message_id: BOT_MESSAGE_ID },
	referenced_message: null,
}), {
	...classificationOptions,
	isKnownBotMessage: (id) => id === BOT_MESSAGE_ID,
})?.trigger, "reply", "known outbound message IDs recover replies with an absent referenced message");
assert.equal(classifyDiscordMessageCreate(message(), {
	...classificationOptions,
	allowAmbientGuildMessages: true,
})?.trigger, "ambient");

assert.equal(classifyDiscordMessageCreate(message({
	author: { id: BOT_ID, username: "sample-bot" },
}), classificationOptions), null, "self messages are ignored");
assert.equal(classifyDiscordMessageCreate(message({
	author: { id: OTHER_USER_ID, username: "other-bot", bot: true },
}), classificationOptions), null, "bot-authored messages are ignored");
assert.equal(classifyDiscordMessageCreate(message({
	author: { id: OTHER_USER_ID, username: "system-user", system: true },
}), classificationOptions), null, "system-authored messages are ignored");
assert.equal(classifyDiscordMessageCreate(message({ webhook_id: OTHER_USER_ID }), classificationOptions), null, "webhook messages are ignored");
assert.equal(classifyDiscordMessageCreate({
	...message(),
	mentions: [null],
} as unknown as DiscordMessageCreate, classificationOptions), null, "malformed mention entries are ignored safely");

function makeHandler(events: MomEvent[]): MomHandler {
	return {
		isRunning: () => false,
		handleEvent: async (event) => { events.push(event); },
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
}

function normalized(overrides: Partial<DiscordGatewayMessagePayload> = {}): DiscordGatewayMessagePayload {
	return {
		type: "message",
		trigger: "reply",
		channelId: GUILD_CHANNEL_ID,
		channelName: "sample-channel",
		guildId: GUILD_ID,
		author: { id: USER_ID, username: "sample-user", global_name: "Sample User" },
		content: "following up",
		rawContent: "following up",
		messageId: MESSAGE_ID,
		isDM: false,
		timestamp: "2026-01-01T00:00:00.000Z",
		botUserId: BOT_ID,
		...overrides,
		rawContent: overrides.rawContent ?? overrides.content ?? "following up",
	};
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-discord-boundary-"));
const deniedDmDir = mkdtempSync(join(tmpdir(), "tm-discord-denied-dm-"));
try {
	const events: MomEvent[] = [];
	const pulse = new ChannelPulse("pending");
	const adapter = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir,
		allowedGuildIds: [GUILD_ID],
		allowedChannelIds: [GUILD_CHANNEL_ID],
		allowedUserIds: [USER_ID, OTHER_USER_ID],
		allowedDmUserIds: [USER_ID],
		pulse,
	});
	adapter.setHandler(makeHandler(events));

	assert.equal(await adapter.handleGatewayMessage(normalized({
		trigger: "dm",
		guildId: GUILD_ID,
		isDM: true,
		content: "inconsistent forged direct message",
	})), false, "a guild payload cannot claim the DM allowlist scope");
	assert.equal(await adapter.handleGatewayMessage(normalized({
		trigger: "mention",
		guildId: null,
		isDM: false,
		content: "inconsistent forged guild message",
	})), false, "a DM payload cannot claim the guild allowlist scope");
	assert.equal(await adapter.handleGatewayMessage(normalized({
		trigger: "ambient",
		channelId: DM_CHANNEL_ID,
		guildId: null,
		isDM: true,
		content: "inconsistent ambient direct message",
	})), false, "a DM cannot be reclassified as ambient relay traffic");

	assert.equal(await adapter.handleGatewayMessage(normalized({
		guildId: OTHER_GUILD_ID,
		channelId: GUILD_CHANNEL_ID,
		content: "denied guild content",
	})), false);
	assert.equal(await adapter.handleGatewayMessage(normalized({
		channelId: GUILD_CHANNEL_ID,
		author: { id: DISALLOWED_USER_ID, username: "disallowed-user" },
		content: "denied user content",
	})), false);
	assert.equal(await adapter.handleGatewayMessage(normalized({
		channelId: OTHER_CHANNEL_ID,
		content: "denied channel content",
	})), false);
	assert.equal(adapter.getChannel(GUILD_CHANNEL_ID), undefined, "rejected messages do not enter channel metadata");
	assert.equal(adapter.getChannel(OTHER_CHANNEL_ID), undefined, "rejected messages do not enter channel metadata");
	assert.equal(adapter.getUser(DISALLOWED_USER_ID), undefined, "user-rejected messages do not enter user metadata");
	assert.equal(pulse.recentMessages(GUILD_CHANNEL_ID).length, 0, "rejected messages do not enter channel pulse");
	assert.equal(pulse.recentMessages(OTHER_CHANNEL_ID).length, 0, "channel-rejected messages do not enter channel pulse");

	assert.equal(await adapter.handleGatewayMessage(normalized()), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(events.length, 1);
	assert.equal(events[0]?.sourceEventType, "discord_reply");
	assert.equal(events[0]?.directlyAddressed, true);
	assert.equal(events[0]?.replyTarget, `discord:${GUILD_CHANNEL_ID}`);
	assert.match(events[0]?.replyTargetDescription || "", /reply to the bot/);
	assert.equal(adapter.getChannel(GUILD_CHANNEL_ID)?.name, "sample-channel");
	assert.equal(adapter.getUser(USER_ID)?.displayName, "Sample User");

	assert.equal(await adapter.handleGatewayMessage(normalized({
		trigger: "dm",
		channelId: DM_CHANNEL_ID,
		guildId: null,
		isDM: true,
		messageId: "500000000000000007",
		content: "allowed direct message",
	})), true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(events[1]?.type, "dm");
	assert.equal(adapter.getChannel(DM_CHANNEL_ID)?.name, "sample-channel", "DM metadata is accepted without a channel allowlist match");
	assert.equal(pulse.recentMessages(DM_CHANNEL_ID).length, 1, "authorized DM enters channel pulse");

	assert.equal(await adapter.handleGatewayMessage(normalized({
		trigger: "dm",
		channelId: UNAUTHORIZED_DM_CHANNEL_ID,
		guildId: null,
		isDM: true,
		author: { id: OTHER_USER_ID, username: "other-user" },
		messageId: "500000000000000008",
		content: "unauthorized direct message",
	})), false);
	assert.equal(events.length, 2, "unauthorized DM does not reach the handler");
	assert.equal(adapter.getUser(OTHER_USER_ID), undefined, "unauthorized DM does not enter user metadata");
	assert.equal(adapter.getChannel(UNAUTHORIZED_DM_CHANNEL_ID), undefined, "unauthorized DM does not enter channel metadata");
	assert.equal(pulse.recentMessages(UNAUTHORIZED_DM_CHANNEL_ID).length, 0, "unauthorized DM does not enter channel pulse");

	const logText = readFileSync(join(workingDir, "log.jsonl"), "utf8");
	assert.doesNotMatch(logText, /inconsistent forged|inconsistent ambient|denied guild content|denied user content|denied channel content|unauthorized direct message/);
	assert.match(logText, /following up/);
	assert.match(logText, /allowed direct message/);

	const deniedDmEvents: MomEvent[] = [];
	const deniedDmAdapter = new DiscordGatewayAdapter({
		botToken: "test-bot-token",
		applicationId: BOT_ID,
		workingDir: deniedDmDir,
		allowedDmUserIds: [],
	});
	deniedDmAdapter.setHandler(makeHandler(deniedDmEvents));
	assert.equal(await deniedDmAdapter.handleGatewayMessage(normalized({
		trigger: "dm",
		channelId: DM_CHANNEL_ID,
		guildId: null,
		isDM: true,
		content: "private denied content",
	})), false);
	assert.equal(deniedDmEvents.length, 0);
	assert.equal(existsSync(join(deniedDmDir, "log.jsonl")), false, "empty DM allowlist rejects before persistence");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
	rmSync(deniedDmDir, { recursive: true, force: true });
}

console.log("discord-gateway-classification ok");
