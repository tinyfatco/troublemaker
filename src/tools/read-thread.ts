/**
 * read_thread — inspect messages for a Slack thread target.
 *
 * `list_channels` tells the agent which Slack thread targets exist. This tool
 * gives the agent enough transcript context to choose among similar threads
 * without guessing or collapsing distinct roots together. It prefers the live
 * Slack API transcript and falls back to the local log when API access is not
 * available.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PlatformAdapter, ThreadTranscriptMessage } from "../adapters/types.js";
import { parseEmailThreadTarget, readEmailThreadById, type EmailThreadLedgerRecord } from "../adapters/email/thread-ledger.js";
import { displayNameForEntry, readLogEntries, type LogEntry } from "./list-channels.js";

const SLACK_THREAD_TARGET_RE = /^slack:([CDG][A-Z0-9]+):(\d+\.\d+)$/i;
const MATTERMOST_THREAD_TARGET_RE = /^mattermost:([a-z0-9]{26}):([a-z0-9]{26})$/;

export interface SlackThreadTargetParts {
	channelId: string;
	threadTs: string;
	inputTarget: string;
}

export interface SlackThreadMessage {
	date: string;
	ts: string;
	threadTs: string;
	channelId: string;
	channelName: string;
	sender: string;
	text: string;
	isRoot: boolean;
	isBot: boolean;
	directlyAddressed?: boolean;
	sourceEventType?: string;
}

export interface SlackThreadReadResult {
	target: SlackThreadTargetParts;
	messages: SlackThreadMessage[];
	source: "slack-api" | "log";
	warning?: string;
}

export interface ConversationThreadTargetParts {
	platform: "slack" | "mattermost" | "email" | "phone";
	inputTarget: string;
	label: string;
}

export interface ConversationThreadMessage {
	date: string;
	ts: string;
	sender: string;
	text: string;
	isRoot: boolean;
	isBot: boolean;
	directlyAddressed?: boolean;
	sourceEventType?: string;
}

export interface ConversationThreadReadResult {
	target: ConversationThreadTargetParts;
	messages: ConversationThreadMessage[];
	source: "slack-api" | "mattermost-api" | "log" | "email-ledger" | "phone-log";
	warning?: string;
}

export function parseSlackThreadTarget(target: string): SlackThreadTargetParts | null {
	const match = target.trim().match(SLACK_THREAD_TARGET_RE);
	if (!match) return null;
	return {
		channelId: match[1],
		threadTs: match[2],
		inputTarget: `slack:${match[1]}:${match[2]}`,
	};
}

export function parseMattermostThreadTarget(target: string): SlackThreadTargetParts | null {
	const match = target.trim().match(MATTERMOST_THREAD_TARGET_RE);
	if (!match) return null;
	return {
		channelId: match[1],
		threadTs: match[2],
		inputTarget: `mattermost:${match[1]}:${match[2]}`,
	};
}

function channelNameForEntry(entry: LogEntry): string {
	const channel = entry.channel || "";
	return channel.startsWith("slack:#") ? channel.slice("slack:#".length) : entry.channelId || "unknown";
}

function normalizeText(text: unknown, maxLength = 1000): string {
	if (typeof text !== "string") return "";
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

function logEntryThreadTs(entry: LogEntry): string | undefined {
	return entry.threadTs || entry.ts;
}

export function collectSlackThreadMessagesFromLog(
	workingDir: string,
	target: string,
	limit = 40,
): SlackThreadReadResult | null {
	const parsed = parseSlackThreadTarget(target);
	if (!parsed) return null;

	const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 40, 100));
	const messages = readLogEntries(workingDir)
		.filter((entry) => {
			if (!entry.channel || !entry.channel.startsWith("slack:")) return false;
			if (entry.channelId !== parsed.channelId) return false;
			if (!entry.ts) return false;
			return logEntryThreadTs(entry) === parsed.threadTs;
		})
		.sort((a, b) => (a.date || a.ts || "").localeCompare(b.date || b.ts || ""))
		.slice(-boundedLimit)
		.map((entry) => ({
			date: entry.date || "",
			ts: entry.ts || "",
			threadTs: parsed.threadTs,
			channelId: parsed.channelId,
			channelName: channelNameForEntry(entry),
			sender: displayNameForEntry(entry),
			text: normalizeText(entry.text),
			isRoot: entry.ts === parsed.threadTs,
			isBot: Boolean(entry.isBot),
			directlyAddressed: entry.directlyAddressed,
			sourceEventType: entry.sourceEventType,
		}));

	return { target: parsed, messages, source: "log" };
}

export async function collectSlackThreadMessages(
	workingDir: string,
	target: string,
	adapters: PlatformAdapter[] = [],
	limit = 40,
): Promise<SlackThreadReadResult | null> {
	const parsed = parseSlackThreadTarget(target);
	if (!parsed) return null;

	const slack = adapters.find((adapter) => adapter.name === "slack" && typeof adapter.readThread === "function");
	if (slack?.readThread) {
		try {
			const rawMessages = await slack.readThread(parsed.channelId, parsed.threadTs, limit);
			return {
				target: parsed,
				messages: rawMessages.map(normalizeThreadTranscriptMessage),
				source: "slack-api",
			};
		} catch (err) {
			const fallback = collectSlackThreadMessagesFromLog(workingDir, target, limit);
			if (fallback) {
				return {
					...fallback,
					warning: `Slack API transcript read failed; using local log fallback: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
			throw err;
		}
	}

	return collectSlackThreadMessagesFromLog(workingDir, target, limit);
}

export async function collectMattermostThreadMessages(
	workingDir: string,
	target: string,
	adapters: PlatformAdapter[] = [],
	limit = 40,
): Promise<ConversationThreadReadResult | null> {
	const parsed = parseMattermostThreadTarget(target);
	if (!parsed) return null;
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 40, 100));
	const fallback = (): ConversationThreadReadResult => {
		const entries = readLogEntries(workingDir)
			.filter((entry) => entry.channel?.startsWith("mattermost:")
				&& entry.channelId === parsed.channelId
				&& entry.ts
				&& logEntryThreadTs(entry) === parsed.threadTs)
			.sort((a, b) => (a.date || a.ts || "").localeCompare(b.date || b.ts || ""))
			.slice(-boundedLimit);
		const label = entries[0]?.channel?.slice("mattermost:".length) || parsed.channelId;
		return {
			target: { platform: "mattermost", inputTarget: parsed.inputTarget, label },
			messages: entries.map((entry) => ({
				date: entry.date || "",
				ts: entry.ts || "",
				sender: displayNameForEntry(entry),
				text: normalizeText(entry.text),
				isRoot: entry.ts === parsed.threadTs,
				isBot: Boolean(entry.isBot),
				directlyAddressed: entry.directlyAddressed,
				sourceEventType: entry.sourceEventType,
			})),
			source: "log",
		};
	};

	const mattermost = adapters.find((adapter) => adapter.name === "mattermost" && typeof adapter.readThread === "function");
	if (!mattermost?.readThread) return fallback();
	try {
		const rawMessages = await mattermost.readThread(parsed.channelId, parsed.threadTs, boundedLimit);
		return {
			target: {
				platform: "mattermost",
				inputTarget: parsed.inputTarget,
				label: rawMessages[0]?.channelName || parsed.channelId,
			},
			messages: rawMessages.map((message) => ({
				date: message.date || "",
				ts: message.ts,
				sender: message.sender,
				text: normalizeText(message.text),
				isRoot: message.isRoot,
				isBot: Boolean(message.isBot),
				directlyAddressed: message.directlyAddressed,
				sourceEventType: message.sourceEventType,
			})),
			source: "mattermost-api",
		};
	} catch (error) {
		return {
			...fallback(),
			warning: `Mattermost API transcript read failed; using local log fallback: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export async function collectThreadMessages(
	workingDir: string,
	target: string,
	adapters: PlatformAdapter[] = [],
	limit = 40,
): Promise<ConversationThreadReadResult | null> {
	const slack = await collectSlackThreadMessages(workingDir, target, adapters, limit);
	if (slack) return slackToConversationThread(slack);

	const mattermost = await collectMattermostThreadMessages(workingDir, target, adapters, limit);
	if (mattermost) return mattermost;

	const email = collectEmailThreadMessages(workingDir, target, limit);
	if (email) return email;

	const phone = collectPhoneThreadMessagesFromLog(workingDir, target, limit);
	if (phone) return phone;

	return null;
}

export function collectEmailThreadMessages(
	workingDir: string,
	target: string,
	limit = 40,
): ConversationThreadReadResult | null {
	const parsed = parseEmailThreadTarget(target);
	if (!parsed) return null;
	const records = readEmailThreadById(workingDir, parsed.threadId, limit);
	const subject = records.find((record) => record.subject)?.subject || parsed.threadId;
	return {
		target: {
			platform: "email",
			inputTarget: parsed.inputTarget,
			label: subject,
		},
		messages: records.map(emailRecordToThreadMessage),
		source: "email-ledger",
	};
}

export function collectPhoneThreadMessagesFromLog(
	workingDir: string,
	target: string,
	limit = 40,
): ConversationThreadReadResult | null {
	const normalizedTarget = target.trim();
	if (!normalizedTarget.startsWith("phone-")) return null;
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 40, 100));
	const messages = readLogEntries(workingDir)
		.filter((entry) => entry.channelId === normalizedTarget && entry.channel?.startsWith("phone:"))
		.sort((a, b) => (a.date || a.ts || "").localeCompare(b.date || b.ts || ""))
		.slice(-boundedLimit)
		.map((entry, index) => ({
			date: entry.date || "",
			ts: entry.ts || entry.date || "",
			sender: displayNameForEntry(entry),
			text: normalizeText(entry.text),
			isRoot: index === 0,
			isBot: Boolean(entry.isBot),
			directlyAddressed: entry.directlyAddressed,
			sourceEventType: entry.sourceEventType,
		}));
	const label = readLogEntries(workingDir)
		.find((entry) => entry.channelId === normalizedTarget && entry.channel?.startsWith("phone:"))
		?.channel?.slice("phone:".length) || normalizedTarget;
	return {
		target: {
			platform: "phone",
			inputTarget: normalizedTarget,
			label,
		},
		messages,
		source: "phone-log",
	};
}

function normalizeThreadTranscriptMessage(message: ThreadTranscriptMessage): SlackThreadMessage {
	return {
		date: message.date || "",
		ts: message.ts,
		threadTs: message.threadTs,
		channelId: message.channelId,
		channelName: message.channelName || message.channelId,
		sender: message.sender || "unknown",
		text: normalizeText(message.text),
		isRoot: message.isRoot,
		isBot: Boolean(message.isBot),
		directlyAddressed: message.directlyAddressed,
		sourceEventType: message.sourceEventType,
	};
}

export function formatSlackThreadTranscript(
	result: SlackThreadReadResult,
): string {
	const { target, messages, source, warning } = result;
	if (messages.length === 0) {
		return [
			`Slack thread ${target.inputTarget}`,
			`Source: ${source === "slack-api" ? "Slack API" : "local log"}`,
			...(warning ? [`Warning: ${warning}`] : []),
			"",
			source === "slack-api"
				? "No Slack messages were found for this thread target. Confirm the target exists and the app has access to that channel."
				: "No logged messages were found for this thread target. Use list_channels to discover recent Slack thread targets, or wait for Slack activity to be logged.",
		].join("\n");
	}

	const first = messages[0];
	const channelName = first.channelName ? `#${first.channelName}` : target.channelId;
	const lines = [
		`Slack thread ${target.inputTarget}`,
		`Channel: ${channelName}`,
		`Source: ${source === "slack-api" ? "Slack API" : "local log"}`,
		`Messages shown: ${messages.length}`,
		"",
		"Transcript:",
	];
	if (warning) lines.splice(3, 0, `Warning: ${warning}`);

	for (const message of messages) {
		const marker = message.isRoot ? "root" : "reply";
		const flags = [
			message.isBot ? "Zip" : "human",
			message.directlyAddressed ? "direct" : "ambient/passive",
			message.sourceEventType,
		].filter(Boolean).join(", ");
		const when = message.date || message.ts;
		lines.push(`- [${marker}] ${when} ${message.sender}${flags ? ` (${flags})` : ""}: ${message.text || "(no text captured)"}`);
	}

	return lines.join("\n");
}

export function formatThreadTranscript(result: ConversationThreadReadResult): string {
	const { target, messages, source, warning } = result;
	const platformName = target.platform === "slack"
		? "Slack thread"
		: target.platform === "mattermost"
			? "Mattermost thread"
			: target.platform === "email"
				? "Email thread"
				: "Phone conversation";
	const sourceLabel = source === "slack-api"
		? "Slack API"
		: source === "mattermost-api"
			? "Mattermost API"
		: source === "email-ledger"
			? "email ledger"
			: source === "phone-log"
				? "phone log"
				: "local log";

	if (messages.length === 0) {
		return [
			`${platformName} ${target.inputTarget}`,
			`Subject/Conversation: ${target.label}`,
			`Source: ${sourceLabel}`,
			...(warning ? [`Warning: ${warning}`] : []),
			"",
			"No messages were found for this target. Use list_channels to discover recent conversation targets, or wait for new activity to be logged.",
		].join("\n");
	}

	const lines = [
		`${platformName} ${target.inputTarget}`,
		`Subject/Conversation: ${target.label}`,
		`Source: ${sourceLabel}`,
		`Messages shown: ${messages.length}`,
		"",
		"Transcript:",
	];
	if (warning) lines.splice(3, 0, `Warning: ${warning}`);

	for (const message of messages) {
		const marker = message.isRoot ? "root" : "reply";
		const flags = [
			message.isBot ? "Zip" : "human",
			message.directlyAddressed ? "direct" : undefined,
			message.sourceEventType,
		].filter(Boolean).join(", ");
		const when = message.date || message.ts;
		lines.push(`- [${marker}] ${when} ${message.sender}${flags ? ` (${flags})` : ""}: ${message.text || "(no text captured)"}`);
	}

	return lines.join("\n");
}

function slackToConversationThread(result: SlackThreadReadResult): ConversationThreadReadResult {
	const first = result.messages[0];
	const label = first?.channelName ? `#${first.channelName}` : result.target.channelId;
	return {
		target: {
			platform: "slack",
			inputTarget: result.target.inputTarget,
			label,
		},
		messages: result.messages.map((message) => ({
			date: message.date,
			ts: message.ts,
			sender: message.sender,
			text: message.text,
			isRoot: message.isRoot,
			isBot: message.isBot,
			directlyAddressed: message.directlyAddressed,
			sourceEventType: message.sourceEventType,
		})),
		source: result.source,
		warning: result.warning,
	};
}

function emailRecordToThreadMessage(record: EmailThreadLedgerRecord): ConversationThreadMessage {
	return {
		date: record.at || "",
		ts: record.providerMessageId || record.messageId || record.at || "",
		sender: record.type === "outbound" ? "Zip" : record.from || "unknown",
		text: normalizeText(record.body),
		isRoot: !record.inReplyTo && !record.references,
		isBot: record.type === "outbound",
		sourceEventType: `email_${record.type}`,
	};
}

export function createReadThreadTool(workingDir: string, adapters: PlatformAdapter[] = []): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description of the conversation you're reading and why (shown to user)" }),
		show: Type.Optional(Type.Boolean({ description: "Surface this safe label only when it is a meaningful progress milestone. Default false." })),
		target: Type.String({ description: "Conversation target from list_channels or delivery context, e.g. mattermost:<channel>:<root>, slack:C0AN1GL51K7:1779777014.658729, email-thread:0123abcd..., or phone-..." }),
		limit: Type.Optional(Type.Number({ description: "Maximum messages to return, newest window, default 40, max 100" })),
	});

	return {
		name: "read_thread",
		label: "read_thread",
		description:
			"Read the transcript for a conversation target such as mattermost:<channel>:<root>, slack:<channel>:<thread_ts>, email-thread:<id>, or phone-..., with API/log/ledger fallback. " +
			"Use this after list_channels when several conversations are active and you need the nuance/context before choosing a send_message target.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown) => {
			const { target, limit } = params as { target?: string; limit?: number };
			if (typeof target !== "string" || !target.trim()) {
				throw new Error("read_thread requires a conversation target like mattermost:<channel>:<root>, slack:C0AN1GL51K7:1779777014.658729, email-thread:0123abcd..., or phone-.... Use list_channels to discover targets.");
			}
			const result = await collectThreadMessages(workingDir, target, adapters, limit);
			if (!result) {
				throw new Error(`Invalid conversation target "${target}". Expected mattermost:<channel>:<root>, slack:<channel>:<thread_ts>, email-thread:<id>, or phone-....`);
			}
			return {
				content: [{ type: "text" as const, text: formatThreadTranscript(result) }],
				details: undefined,
			};
		},
	};
}
