import type { DiscordBaseConfig } from "./discord-base.js";

export const DEFAULT_DISCORD_GATEWAY_INTENTS = (
	(1 << 0) // GUILDS
	| (1 << 9) // GUILD_MESSAGES
	| (1 << 12) // DIRECT_MESSAGES
	| (1 << 15) // MESSAGE_CONTENT (privileged; must be enabled for the app)
);

export type DiscordBoundaryEnvironmentConfig = Pick<
	DiscordBaseConfig,
	"allowedGuildIds" | "allowedChannelIds" | "allowedUserIds" | "allowedDmUserIds"
>;

export interface DiscordGatewayEnvironmentConfig extends DiscordBoundaryEnvironmentConfig {
	intents: number;
	allowAmbientGuildMessages: boolean;
	shardId?: number;
	shardCount?: number;
}

export type DiscordAdapterSelection = "discord:gateway" | "discord:webhook";

/** `discord` is the normal host-mode spelling; the fully qualified form is explicit in logs. */
export function normalizeDiscordAdapterName(name: string): string {
	return name === "discord" ? "discord:gateway" : name;
}

/**
	* Preserve signed webhook auto-detection. Gateway auto-detection requires an
	* explicit opt-in so adding bot credentials to an existing deployment cannot
	* silently open a new inbound surface.
	*/
export function detectDiscordAdapterFromEnv(env: NodeJS.ProcessEnv): DiscordAdapterSelection | undefined {
	const hasGatewayCredentials = !!env.MOM_DISCORD_BOT_TOKEN && !!env.MOM_DISCORD_APPLICATION_ID;
	if (parseBoolean(env.MOM_DISCORD_GATEWAY, false, "MOM_DISCORD_GATEWAY")) return "discord:gateway";
	if (hasGatewayCredentials && env.MOM_DISCORD_PUBLIC_KEY) return "discord:webhook";
	return undefined;
}

export function readDiscordGatewayEnvironment(env: NodeJS.ProcessEnv): DiscordGatewayEnvironmentConfig {
	const shardId = parseOptionalInteger(env.MOM_DISCORD_GATEWAY_SHARD_ID, "MOM_DISCORD_GATEWAY_SHARD_ID", 0);
	const shardCount = parseOptionalInteger(env.MOM_DISCORD_GATEWAY_SHARD_COUNT, "MOM_DISCORD_GATEWAY_SHARD_COUNT", 1);
	if ((shardId === undefined) !== (shardCount === undefined)) {
		throw new Error("MOM_DISCORD_GATEWAY_SHARD_ID and MOM_DISCORD_GATEWAY_SHARD_COUNT must be set together");
	}
	if (shardId !== undefined && shardCount !== undefined && shardId >= shardCount) {
		throw new Error("MOM_DISCORD_GATEWAY_SHARD_ID must be less than MOM_DISCORD_GATEWAY_SHARD_COUNT");
	}

	return {
		...readDiscordBoundaryEnvironment(env),
		intents: parseOptionalInteger(
			env.MOM_DISCORD_GATEWAY_INTENTS,
			"MOM_DISCORD_GATEWAY_INTENTS",
			0,
			Number.MAX_SAFE_INTEGER,
		) ?? DEFAULT_DISCORD_GATEWAY_INTENTS,
		allowAmbientGuildMessages: parseBoolean(
			env.MOM_DISCORD_GATEWAY_AMBIENT_MESSAGES,
			false,
			"MOM_DISCORD_GATEWAY_AMBIENT_MESSAGES",
		),
		shardId,
		shardCount,
	};
}

export function readDiscordBoundaryEnvironment(env: NodeJS.ProcessEnv): DiscordBoundaryEnvironmentConfig {
	return {
		allowedGuildIds: parseOptionalSnowflakeList(env.MOM_DISCORD_ALLOWED_GUILDS, "MOM_DISCORD_ALLOWED_GUILDS"),
		allowedChannelIds: parseOptionalSnowflakeList(env.MOM_DISCORD_ALLOWED_CHANNELS, "MOM_DISCORD_ALLOWED_CHANNELS"),
		allowedUserIds: parseOptionalSnowflakeList(env.MOM_DISCORD_ALLOWED_USERS, "MOM_DISCORD_ALLOWED_USERS"),
		allowedDmUserIds: parseOptionalSnowflakeList(env.MOM_DISCORD_ALLOWED_DM_USERS, "MOM_DISCORD_ALLOWED_DM_USERS"),
	};
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1") return true;
	if (normalized === "false" || normalized === "0") return false;
	throw new Error(`${name} must be true or false`);
}

function parseOptionalInteger(value: string | undefined, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
	if (value === undefined || !value.trim()) return undefined;
	if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be an integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return parsed;
}

function parseOptionalSnowflakeList(value: string | undefined, name: string): string[] | undefined {
	if (value === undefined) return undefined;
	const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
	for (const id of ids) {
		if (!/^\d{17,20}$/.test(id)) throw new Error(`${name} contains an invalid Discord snowflake`);
	}
	return ids;
}
