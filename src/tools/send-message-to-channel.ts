/**
 * send_message_to_channel — send a message to any connected channel.
 *
 * Lets the agent send a message to any connected channel (Telegram, Slack, Discord, Email, Phone)
 * regardless of which channel the current conversation is on. Fire and forget —
 * the agent stays where it is.
 *
 * Routing is by channel ID pattern:
 *   discord:<17-20 digit snowflake> → Discord
 *   discord-<17-20 digit snowflake> → Discord
 *   17-20 digit snowflake           → Discord
 *   numeric (positive or negative) → Telegram
 *   C/D/G prefix                   → Slack
 *   email-{address}                → Email
 *   phone-{hash}                   → SMS/iMessage phone messaging
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { basename } from "path";
import type { PlatformAdapter } from "../adapters/types.js";
import * as log from "../log.js";

const DISCORD_TARGET_RE = /^discord[:-](\d{17,20})$/;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

export interface ResolvedChannelTarget {
	adapter: PlatformAdapter;
	channel: string;
	inputChannel: string;
}

/** Return the raw Discord channel ID if this target names a Discord channel. */
export function normalizeDiscordChannel(channel: string): string | undefined {
	const prefixed = channel.match(DISCORD_TARGET_RE);
	if (prefixed) return prefixed[1];
	if (DISCORD_SNOWFLAKE_RE.test(channel)) return channel;
	return undefined;
}

/** Resolve which adapter can handle a given channel ID */
export function resolveAdapter(channel: string, adapters: PlatformAdapter[]): PlatformAdapter | undefined {
	return resolveChannelTarget(channel, adapters)?.adapter;
}

/** Resolve the target adapter and the platform-native channel ID to pass to it. */
export function resolveChannelTarget(channel: string, adapters: PlatformAdapter[]): ResolvedChannelTarget | undefined {
	const discordChannel = normalizeDiscordChannel(channel);
	if (discordChannel) {
		const adapter = adapters.find((a) => a.name === "discord");
		if (adapter) return { adapter, channel: discordChannel, inputChannel: channel };
	}
	// Telegram: numeric (positive or negative)
	if (/^-?\d+$/.test(channel)) {
		const adapter = adapters.find((a) => a.name === "telegram");
		if (adapter) return { adapter, channel, inputChannel: channel };
	}
	// Slack: starts with C, D, or G
	if (/^[CDG]/.test(channel)) {
		const adapter = adapters.find((a) => a.name === "slack");
		if (adapter) return { adapter, channel, inputChannel: channel };
	}
	// Email: starts with "email-" (internal channel ID format)
	if (channel.startsWith("email-")) {
		const adapter = adapters.find((a) => a.name === "email");
		if (adapter) return { adapter, channel, inputChannel: channel };
	}
	// Phone messaging: internal channel IDs begin with phone-
	if (channel.startsWith("phone-")) {
		const adapter = adapters.find((a) => a.name === "phone");
		if (adapter) return { adapter, channel, inputChannel: channel };
	}
	return undefined;
}

/**
 * Create the send_message_to_channel tool for cross-channel messaging.
 *
 * @param adapters - All platform adapters available for routing
 */
export function createSendMessageToChannelTool(adapters: PlatformAdapter[]): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description of what you're sending (shown in logs)" }),
		channel: Type.String({ description: "Channel ID to send to (e.g., discord:<channel id>, Telegram chat ID, Slack channel ID, email-user@example.com, phone-...)" }),
		text: Type.String({ description: "Message text to send" }),
		attachments: Type.Optional(Type.Array(Type.String(), { description: "File paths to attach (email only). Each path should be an absolute path to a file on disk." })),
		subject: Type.Optional(Type.String({ description: "Subject line (email only — ignored for Telegram/Slack/Discord). If omitted while replying inside an active email conversation, the current thread subject is reused." })),
	});

	return {
		name: "send_message_to_channel",
		label: "send_message_to_channel",
		description:
			"Send a message to a channel without moving there. Use this to reach people on Telegram, Slack, Discord, Email, or SMS/iMessage " +
			"while staying focused on your current channel. " +
			"The channel ID determines which platform the message goes to: " +
			"discord:<17-20 digit ID> or raw 17-20 digit snowflake → Discord, shorter numeric IDs → Telegram, C/D/G-prefixed → Slack, email-{address} → Email, phone-{hash} → SMS/iMessage. " +
			"For email, you can include file attachments (e.g., PDFs, images) and an optional subject line. " +
			"If you use this during an active email conversation and send back to that same email channel, the adapter preserves reply threading and adds a native-style quoted reply block automatically. " +
			"IMPORTANT: You MUST send a message whenever a cross-channel message arrives while you are working. " +
			"Never leave a cross-channel message unacknowledged.",
		parameters: schema,
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
		) => {
			const { channel, text, attachments, subject } = params as {
				label: string;
				channel: string;
				text: string;
				attachments?: string[];
				subject?: string;
			};
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const target = resolveChannelTarget(channel, adapters);
			if (!target) {
				return {
					content: [{ type: "text" as const, text: `No adapter found for channel "${channel}". Available patterns: discord:<17-20 digit ID> or raw 17-20 digit snowflake (Discord), shorter numeric (Telegram), C/D/G prefix (Slack), email-{address} (Email), phone-{hash} (SMS/iMessage).` }],
					details: undefined,
				};
			}
			const { adapter } = target;

			try {
				// Convert file path strings to attachment objects
				const attachmentObjects = attachments?.map((filePath) => ({
					filePath,
					filename: basename(filePath),
				}));

				// Re-check immediately before the external side effect so an interrupt
				// that arrives during argument prep can suppress stale outbound text.
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const ts = await adapter.postMessage(target.channel, text, attachmentObjects, subject);
				adapter.logBotResponse(target.channel, text, ts);

				const attInfo = attachmentObjects?.length ? ` with ${attachmentObjects.length} attachment(s)` : "";
				log.logInfo(`[send_message_to_channel] Sent to ${adapter.name}:${target.channel}${attInfo}: ${text.substring(0, 80)}`);

				return {
					content: [{ type: "text" as const, text: `Message sent to ${adapter.name} channel ${target.channel}${attInfo} (ts=${ts})` }],
					details: undefined,
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[send_message_to_channel] Failed to send to ${adapter.name}:${target.channel}`, errMsg);
				return {
					content: [{ type: "text" as const, text: `Failed to send message: ${errMsg}` }],
					details: undefined,
				};
			}
		},
	};
}
