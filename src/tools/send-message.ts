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
 *   teams:<encoded conversation>[:<encoded message>] -> Microsoft Teams conversation/thread
 *   mattermost:<channel>[:<root>]   -> Mattermost channel or thread
 *   rocket-chat:<room>[:<root>]     -> Rocket.Chat room or thread
 *   zulip:<channel>                 -> Zulip channel
 *   zulip:<channel>:topic:<encoded> -> Zulip channel topic
 *   zulip:dm:<user IDs>             -> Zulip direct-message conversation
 *   email-thread:<id>               -> Email thread
 *   email-{address}                 -> Email
 *   phone-{hash}                    -> SMS/iMessage phone messaging
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { basename } from "path";
import type { PlatformAdapter } from "../adapters/types.js";
import { parseZulipTarget } from "../adapters/zulip-target.js";
import { parseTeamsTarget } from "../adapters/teams-target.js";
import * as log from "../log.js";
import { waitForToolDisplay } from "../streaming/tool-delivery-barrier.js";

const DISCORD_TARGET_RE = /^discord[:-](\d{17,20})$/;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
const SLACK_THREAD_TARGET_RE = /^slack:([CDG][A-Z0-9]+):(\d+\.\d+)$/i;
const MATTERMOST_TARGET_RE = /^mattermost:([a-z0-9]{26})(?::([a-z0-9]{26}))?$/;
const ROCKET_CHAT_TARGET_RE = /^rocket-chat:([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?$/;
const EMAIL_THREAD_TARGET_RE = /^email-thread:[a-f0-9]{16}$/i;

export interface ResolvedMessageTarget {
	adapter: PlatformAdapter;
	channel: string;
	inputTarget: string;
	threadTs?: string;
}

interface PhoneGroupMessageAdapter extends PlatformAdapter {
	postMessageToRecipients(channel: string, text: string, recipients: string[], attachments?: Array<{ filePath: string; filename: string }>): Promise<string>;
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
	const teamsTarget = parseTeamsTarget(target);
	if (teamsTarget) {
		const adapter = adapters.find((candidate) => candidate.name === "teams");
		if (adapter) return {
			adapter,
			channel: teamsTarget.conversationId,
			...(teamsTarget.messageId ? { threadTs: teamsTarget.messageId } : {}),
			inputTarget: teamsTarget.target,
		};
	}
	const mattermostTarget = target.match(MATTERMOST_TARGET_RE);
	if (mattermostTarget) {
		const adapter = adapters.find((candidate) => candidate.name === "mattermost");
		if (adapter) return {
			adapter,
			channel: mattermostTarget[1],
			...(mattermostTarget[2] ? { threadTs: mattermostTarget[2] } : {}),
			inputTarget: target,
		};
	}
	const rocketChatTarget = target.match(ROCKET_CHAT_TARGET_RE);
	if (rocketChatTarget) {
		const adapter = adapters.find((candidate) => candidate.name === "rocket-chat");
		if (adapter) return {
			adapter,
			channel: rocketChatTarget[1],
			...(rocketChatTarget[2] ? { threadTs: rocketChatTarget[2] } : {}),
			inputTarget: target,
		};
	}
	const zulipTarget = parseZulipTarget(target);
	if (zulipTarget) {
		const adapter = adapters.find((candidate) => candidate.name === "zulip");
		if (adapter) return {
			adapter,
			channel: zulipTarget.channel,
			...(zulipTarget.threadTs ? { threadTs: zulipTarget.threadTs } : {}),
			inputTarget: zulipTarget.inputTarget,
		};
	}
	const slackThread = target.match(SLACK_THREAD_TARGET_RE);
	if (slackThread) {
		const adapter = adapters.find((a) => a.name === "slack");
		if (adapter) return { adapter, channel: slackThread[1], threadTs: slackThread[2], inputTarget: target };
	}
	if (EMAIL_THREAD_TARGET_RE.test(target)) {
		const adapter = adapters.find((a) => a.name === "email");
		if (adapter) return { adapter, channel: target.toLowerCase(), inputTarget: target };
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
		show: Type.Optional(Type.Boolean({ description: "Surface this safe label only when it is a meaningful progress milestone. Default false." })),
		target: Type.String({
			description: "Required destination. Examples: Telegram chat ID, Slack channel ID, slack:<channel>:<thread_ts>, teams:<encoded conversation>[:<encoded message>], mattermost:<channel>[:<root>], rocket-chat:<room>[:<root>], zulip:<channel>[:topic:<encoded>], zulip:dm:<user IDs>, discord:<channel id>, email-thread:<id>, email-user@example.com, phone-...",
		}),
		text: Type.String({ description: "Message text to send" }),
		attachments: Type.Optional(Type.Array(Type.String(), { description: "Absolute file paths to attach on providers that support uploads, including Microsoft Teams, Slack, Mattermost, email, and phone messaging." })),
		subject: Type.Optional(Type.String({ description: "Subject line (email only - ignored for Telegram/Slack/Discord). If omitted while replying inside an active email conversation, the current thread subject is reused." })),
		recipients: Type.Optional(Type.Array(Type.String(), { description: "Phone only: additional E.164 numbers to persist on this phone target and include in the MMS group." })),
	});

	return {
		name: "send_message",
		label: "send_message",
		description:
			"Send a user-visible message. This is the only normal way to deliver text to people on Microsoft Teams, Telegram, Slack, Discord, Email, or SMS/iMessage. " +
			"`target` is required; never omit it. If you do not know where to send, use list_channels or ask for clarification. " +
			"Target formats: teams:<encoded conversation>[:<encoded message>] -> Microsoft Teams conversation/thread, discord:<17-20 digit ID> or raw 17-20 digit snowflake -> Discord, shorter numeric IDs -> Telegram, C/D/G-prefixed -> Slack, slack:<channel>:<thread_ts> -> Slack thread, mattermost:<channel>[:<root>] -> Mattermost channel/thread, rocket-chat:<room>[:<root>] -> Rocket.Chat room/thread, zulip:<channel>[:topic:<encoded>] -> Zulip channel/topic, zulip:dm:<user IDs> -> Zulip DM, email-thread:<id> -> existing Email thread, email-{address} -> Email address, phone-{hash} -> SMS/iMessage conversation. " +
			"For email and Mattermost root messages, you can include file attachments. Email also accepts an optional subject line. " +
			"If you send to an email-thread target, the adapter preserves native Gmail/Outlook threading and adds a native-style quoted reply block automatically. " +
			"IMPORTANT: When a cross-channel message arrives while you are working, you MUST send a message to the appropriate target. Never leave a cross-channel message unacknowledged.",
		parameters: schema,
			execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
			const { target, text, attachments, subject, recipients } = params as {
				label?: string;
				target?: string;
				text?: string;
				attachments?: string[];
				subject?: string;
				recipients?: string[];
			};

			if (signal?.aborted) throw new Error("Operation aborted");

			if (typeof target !== "string" || !target.trim()) {
				throw new Error("send_message requires a target. Give me a destination such as teams:<encoded conversation>[:<encoded message>], rocket-chat:<room>[:<root>], mattermost:<channel>[:<root>], zulip:<channel>[:topic:<encoded>] or zulip:dm:<user IDs>, slack:<channel>:<thread_ts>, email-thread:<id>, email-user@example.com, or phone-....");
			}
			if (typeof text !== "string" || !text.trim()) {
				throw new Error("send_message requires non-empty text.");
			}

			if (isObsoleteSilentControlMessage(text)) {
				log.logWarning(`[send_message] Suppressed obsolete [SILENT] message to ${target}`);
				return {
					content: [{ type: "text" as const, text: "Suppressed obsolete [SILENT] control marker; no user-visible message was sent. Use yield_no_action when no outbound message is needed." }],
					details: { delivered: false },
				};
			}

			const resolved = resolveMessageTarget(target.trim(), adapters);
			if (!resolved) {
				throw new Error(`No adapter found for target "${target}". Valid targets include teams:<encoded conversation>[:<encoded message>], rocket-chat:<room>[:<root>], mattermost:<channel>[:<root>], zulip:<channel>[:topic:<encoded>], zulip:dm:<user IDs>, discord:<17-20 digit ID>, raw Discord snowflake, Telegram numeric chat ID, Slack C/D/G ID, slack:<channel>:<thread_ts>, email-thread:<id>, email-{address}, or phone-{hash}.`);
			}

			try {
				const attachmentObjects = attachments?.map((filePath) => ({
					filePath,
					filename: basename(filePath),
				}));
				const phoneRecipients = normalizePhoneRecipients(recipients);
				if (phoneRecipients.length > 0 && resolved.adapter.name !== "phone") {
					throw new Error("send_message recipients are only supported for phone/SMS/MMS targets.");
				}

				if (signal?.aborted) throw new Error("Operation aborted");
				await waitForToolDisplay(_toolCallId);

				const ts = resolved.threadTs
					? await resolved.adapter.postInThread(resolved.channel, resolved.threadTs, text)
					: phoneRecipients.length > 0
						? await phoneGroupAdapter(resolved.adapter).postMessageToRecipients(resolved.channel, text, phoneRecipients, attachmentObjects)
						: await resolved.adapter.postMessage(resolved.channel, text, attachmentObjects, subject);
				resolved.adapter.logBotResponse(resolved.channel, text, ts, { threadTs: resolved.threadTs });

				const attInfo = attachmentObjects?.length ? ` with ${attachmentObjects.length} attachment(s)` : "";
				const recipientInfo = phoneRecipients.length ? ` to ${phoneRecipients.length + 1} phone participant(s)` : "";
				const threadInfo = resolved.threadTs ? ` thread ${resolved.threadTs}` : "";
				log.logInfo(`[send_message] Sent to ${resolved.adapter.name}:${resolved.channel}${threadInfo}${attInfo}${recipientInfo}: ${text.substring(0, 80)}`);

				return {
					content: [{ type: "text" as const, text: `Message sent to ${resolved.adapter.name} target ${target}${attInfo}${recipientInfo} (ts=${ts})` }],
					details: { delivered: true },
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[send_message] Failed to send to ${resolved.adapter.name}:${resolved.channel}`, errMsg);
				return {
					content: [{ type: "text" as const, text: `Failed to send message: ${errMsg}` }],
					details: { delivered: false },
				};
			}
		},
	};
}

function normalizePhoneRecipients(recipients: unknown): string[] {
	if (!Array.isArray(recipients)) return [];
	return Array.from(new Set(recipients
		.filter((recipient): recipient is string => typeof recipient === "string")
		.map((recipient) => recipient.trim())
		.filter(Boolean)));
}

function phoneGroupAdapter(adapter: PlatformAdapter): PhoneGroupMessageAdapter {
	const maybe = adapter as Partial<PhoneGroupMessageAdapter>;
	if (typeof maybe.postMessageToRecipients !== "function") {
		throw new Error("Phone adapter does not support explicit MMS recipients.");
	}
	return maybe as PhoneGroupMessageAdapter;
}
