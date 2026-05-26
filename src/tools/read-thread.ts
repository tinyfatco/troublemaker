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
import { displayNameForEntry, readLogEntries, type LogEntry } from "./list-channels.js";

const SLACK_THREAD_TARGET_RE = /^slack:([CDG][A-Z0-9]+):(\d+\.\d+)$/i;

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

export function parseSlackThreadTarget(target: string): SlackThreadTargetParts | null {
	const match = target.trim().match(SLACK_THREAD_TARGET_RE);
	if (!match) return null;
	return {
		channelId: match[1],
		threadTs: match[2],
		inputTarget: `slack:${match[1]}:${match[2]}`,
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

export function createReadThreadTool(workingDir: string, adapters: PlatformAdapter[] = []): AgentTool<any> {
	const schema = Type.Object({
		target: Type.String({ description: "Slack thread target from list_channels or delivery context, e.g. slack:C0AN1GL51K7:1779777014.658729" }),
		limit: Type.Optional(Type.Number({ description: "Maximum messages to return, newest window, default 40, max 100" })),
	});

	return {
		name: "read_thread",
		label: "read_thread",
		description:
			"Read the Slack API transcript for a Slack thread target such as slack:<channel>:<thread_ts>, with log fallback. " +
			"Use this after list_channels when several Slack threads are active and you need the nuance/context before choosing a send_message target.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown) => {
			const { target, limit } = params as { target?: string; limit?: number };
			if (typeof target !== "string" || !target.trim()) {
				throw new Error("read_thread requires a Slack thread target like slack:C0AN1GL51K7:1779777014.658729. Use list_channels to discover targets.");
			}
			const result = await collectSlackThreadMessages(workingDir, target, adapters, limit);
			if (!result) {
				throw new Error(`Invalid Slack thread target "${target}". Expected slack:<channel>:<thread_ts>, for example slack:C0AN1GL51K7:1779777014.658729.`);
			}
			return {
				content: [{ type: "text" as const, text: formatSlackThreadTranscript(result) }],
				details: undefined,
			};
		},
	};
}
