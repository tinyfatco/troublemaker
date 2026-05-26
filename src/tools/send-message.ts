/**
 * send_message - the single user-visible message delivery tool.
 *
 * The tool always requires an explicit target. The runtime may suggest useful
 * targets in the turn context, but the agent must choose one when sending.
 *
 * Target routing:
 *   discord:<17-20 digit snowflake> -> Discord
 *   discord-<17-20 digit snowflake> -> Discord
 *   17-20 digit snowflake           -> Discord
 *   numeric (positive or negative)  -> Telegram
 *   C/D/G prefix                    -> Slack channel/DM/group
 *   slack:<channel>:<thread_ts>     -> Slack thread
 *   email-{address}                 -> Email
 *   phone-{hash}                    -> SMS/iMessage phone messaging
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { basename } from "path";
import type { PlatformAdapter } from "../adapters/types.js";
import * as log from "../log.js";

const DISCORD_TARGET_RE = /^discord[:-](\d{17,20})$/;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
const SLACK_THREAD_TARGET_RE = /^slack:([CDG][A-Z0-9]+):(\d+\.\d+)$/i;

export interface ResolvedMessageTarget {
	adapter: PlatformAdapter;
	channel: string;
	inputTarget: string;
	threadTs?: string;
}

export function isObsoleteSilentControlMessage(text: string): boolean {
	return text.trim().toUpperCase() === "[SILENT]";
}

/** Return the raw Discord channel ID if this target names a Discord channel. */
export function normalizeDiscordChannel(target: string): string | undefined {
	const prefixed = target.match(DISCORD_TARGET_RE);
	if (prefixed) return prefixed[1];
	if (DISCORD_SNOWFLAKE_RE.test(target)) return target;
	return undefined;
}

/** Resolve which adapter can handle a given target. */
export function resolveAdapter(target: string, adapters: PlatformAdapter[]): PlatformAdapter | undefined {
	return resolveMessageTarget(target, adapters)?.adapter;
}

/** Resolve the target adapter and native channel/thread destination. */
export function resolveMessageTarget(target: string, adapters: PlatformAdapter[]): ResolvedMessageTarget | undefined {
	const slackThread = target.match(SLACK_THREAD_TARGET_RE);
	if (slackThread) {
		const adapter = adapters.find((a) => a.name === "slack");
		if (adapter) return { adapter, channel: slackThread[1], threadTs: slackThread[2], inputTarget: target };
	}

	const discordChannel = normalizeDiscordChannel(target);
	if (discordChannel) {
		const adapter = adapters.find((a) => a.name === "discord");
		if (adapter) return { adapter, channel: discordChannel, inputTarget: target };
	}
	if (/^-?\d+$/.test(target)) {
		const adapter = adapters.find((a) => a.name === "telegram");
		if (adapter) return { adapter, channel: target, inputTarget: target };
	}
	if (/^[CDG]/.test(target)) {
		const adapter = adapters.find((a) => a.name === "slack");
		if (adapter) return { adapter, channel: target, inputTarget: target };
	}
	if (target.startsWith("email-")) {
		const adapter = adapters.find((a) => a.name === "email");
		if (adapter) return { adapter, channel: target, inputTarget: target };
	}
	if (target.startsWith("phone-")) {
		const adapter = adapters.find((a) => a.name === "phone");
		if (adapter) return { adapter, channel: target, inputTarget: target };
	}
	return undefined;
}

export function createSendMessageTool(adapters: PlatformAdapter[]): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description of what you're sending (shown in logs)" }),
		target: Type.String({
			description: "Required destination. Examples: Telegram chat ID, Slack channel ID, slack:<channel>:<thread_ts>, discord:<channel id>, email-user@example.com, phone-...",
		}),
		text: Type.String({ description: "Message text to send" }),
		attachments: Type.Optional(Type.Array(Type.String(), { description: "File paths to attach (email only). Each path should be an absolute path to a file on disk." })),
		subject: Type.Optional(Type.String({ description: "Subject line (email only - ignored for Telegram/Slack/Discord). If omitted while replying inside an active email conversation, the current thread subject is reused." })),
	});

	return {
		name: "send_message",
		label: "send_message",
		description:
			"Send a user-visible message. This is the only normal way to deliver text to people on Telegram, Slack, Discord, Email, or SMS/iMessage. " +
			"`target` is required; never omit it. If you do not know where to send, use list_channels or ask for clarification. " +
			"Target formats: discord:<17-20 digit ID> or raw 17-20 digit snowflake -> Discord, shorter numeric IDs -> Telegram, C/D/G-prefixed -> Slack, slack:<channel>:<thread_ts> -> Slack thread, email-{address} -> Email, phone-{hash} -> SMS/iMessage. " +
			"For email, you can include file attachments and an optional subject line. " +
			"If you send to the active email conversation target, the adapter preserves reply threading and adds a native-style quoted reply block automatically. " +
			"IMPORTANT: When a cross-channel message arrives while you are working, you MUST send a message to the appropriate target. Never leave a cross-channel message unacknowledged.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
			const { target, text, attachments, subject } = params as {
				label?: string;
				target?: string;
				text?: string;
				attachments?: string[];
				subject?: string;
			};

			if (signal?.aborted) throw new Error("Operation aborted");

			if (typeof target !== "string" || !target.trim()) {
				throw new Error("send_message requires a target. Give me a destination such as a channel ID, email-user@example.com, phone-..., or slack:<channel>:<thread_ts>.");
			}
			if (typeof text !== "string" || !text.trim()) {
				throw new Error("send_message requires non-empty text.");
			}

			if (isObsoleteSilentControlMessage(text)) {
				log.logWarning(`[send_message] Suppressed obsolete [SILENT] message to ${target}`);
				return {
					content: [{ type: "text" as const, text: "Suppressed obsolete [SILENT] control marker; no user-visible message was sent. Use yield_no_action when no outbound message is needed." }],
					details: undefined,
				};
			}

			const resolved = resolveMessageTarget(target.trim(), adapters);
			if (!resolved) {
				throw new Error(`No adapter found for target "${target}". Valid targets include discord:<17-20 digit ID>, raw Discord snowflake, Telegram numeric chat ID, Slack C/D/G ID, slack:<channel>:<thread_ts>, email-{address}, or phone-{hash}.`);
			}

			try {
				const attachmentObjects = attachments?.map((filePath) => ({
					filePath,
					filename: basename(filePath),
				}));

				if (signal?.aborted) throw new Error("Operation aborted");

				const ts = resolved.threadTs
					? await resolved.adapter.postInThread(resolved.channel, resolved.threadTs, text)
					: await resolved.adapter.postMessage(resolved.channel, text, attachmentObjects, subject);
				resolved.adapter.logBotResponse(resolved.channel, text, ts, { threadTs: resolved.threadTs });

				const attInfo = attachmentObjects?.length ? ` with ${attachmentObjects.length} attachment(s)` : "";
				const threadInfo = resolved.threadTs ? ` thread ${resolved.threadTs}` : "";
				log.logInfo(`[send_message] Sent to ${resolved.adapter.name}:${resolved.channel}${threadInfo}${attInfo}: ${text.substring(0, 80)}`);

				return {
					content: [{ type: "text" as const, text: `Message sent to ${resolved.adapter.name} target ${target}${attInfo} (ts=${ts})` }],
					details: undefined,
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[send_message] Failed to send to ${resolved.adapter.name}:${resolved.channel}`, errMsg);
				return {
					content: [{ type: "text" as const, text: `Failed to send message: ${errMsg}` }],
					details: undefined,
				};
			}
		},
	};
}
