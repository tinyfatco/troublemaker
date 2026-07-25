import assert from "node:assert/strict";
import {
	DEFAULT_DISCORD_GATEWAY_INTENTS,
	detectDiscordAdapterFromEnv,
	normalizeDiscordAdapterName,
	readDiscordGatewayEnvironment,
} from "../src/adapters/discord-config.js";

// Synthetic Discord-shaped fixtures; none identify a real account or deployment.
const BOT_ID = "100000000000000001";
const GUILD_ID = "200000000000000002";
const CHANNEL_ID = "300000000000000003";
const USER_ID = "400000000000000004";

assert.equal(normalizeDiscordAdapterName("discord"), "discord:gateway");
assert.equal(normalizeDiscordAdapterName("discord:webhook"), "discord:webhook");

assert.equal(detectDiscordAdapterFromEnv({
	MOM_DISCORD_BOT_TOKEN: "test-bot-token",
	MOM_DISCORD_APPLICATION_ID: BOT_ID,
}), undefined, "credentials alone do not silently activate a new inbound mode");

assert.equal(detectDiscordAdapterFromEnv({
	MOM_DISCORD_BOT_TOKEN: "test-bot-token",
	MOM_DISCORD_APPLICATION_ID: BOT_ID,
	MOM_DISCORD_PUBLIC_KEY: "00".repeat(32),
}), "discord:webhook", "existing signed webhook auto-detection is preserved");

assert.equal(detectDiscordAdapterFromEnv({
	MOM_DISCORD_BOT_TOKEN: "test-bot-token",
	MOM_DISCORD_APPLICATION_ID: BOT_ID,
	MOM_DISCORD_PUBLIC_KEY: "00".repeat(32),
	MOM_DISCORD_GATEWAY: "true",
}), "discord:gateway", "explicit Gateway opt-in wins over webhook auto-detection");
assert.equal(detectDiscordAdapterFromEnv({
	MOM_DISCORD_GATEWAY: "true",
}), "discord:gateway", "explicit Gateway opt-in reaches normal missing-credential validation");

const defaults = readDiscordGatewayEnvironment({});
assert.equal(defaults.intents, DEFAULT_DISCORD_GATEWAY_INTENTS);
assert.equal(defaults.allowAmbientGuildMessages, false, "ambient guild intake is closed by default");
assert.equal(defaults.allowedGuildIds, undefined);

const isolated = readDiscordGatewayEnvironment({
	MOM_DISCORD_GATEWAY_INTENTS: "37377",
	MOM_DISCORD_GATEWAY_AMBIENT_MESSAGES: "true",
	MOM_DISCORD_ALLOWED_GUILDS: GUILD_ID,
	MOM_DISCORD_ALLOWED_CHANNELS: CHANNEL_ID,
	MOM_DISCORD_ALLOWED_USERS: USER_ID,
	MOM_DISCORD_ALLOWED_DM_USERS: "",
	MOM_DISCORD_GATEWAY_SHARD_ID: "0",
	MOM_DISCORD_GATEWAY_SHARD_COUNT: "2",
});
assert.deepEqual(isolated.allowedGuildIds, [GUILD_ID]);
assert.deepEqual(isolated.allowedChannelIds, [CHANNEL_ID]);
assert.deepEqual(isolated.allowedUserIds, [USER_ID]);
assert.deepEqual(isolated.allowedDmUserIds, [], "an explicit empty DM list remains fail-closed");
assert.equal(isolated.allowAmbientGuildMessages, true);
assert.equal(isolated.shardId, 0);
assert.equal(isolated.shardCount, 2);

assert.throws(
	() => readDiscordGatewayEnvironment({ MOM_DISCORD_ALLOWED_USERS: "not-a-snowflake" }),
	/invalid Discord snowflake/,
);
assert.throws(
	() => readDiscordGatewayEnvironment({ MOM_DISCORD_GATEWAY_SHARD_ID: "0" }),
	/must be set together/,
);
assert.throws(
	() => detectDiscordAdapterFromEnv({
		MOM_DISCORD_BOT_TOKEN: "test-bot-token",
		MOM_DISCORD_APPLICATION_ID: BOT_ID,
		MOM_DISCORD_GATEWAY: "sometimes",
	}),
	/must be true or false/,
);

console.log("discord-gateway-config ok");
