/**
 * list_channels — list every channel the agent has interacted with.
 *
 * Reads log.jsonl (the agent's unified activity log written by every adapter)
 * and returns the unique set of channels the agent has ever sent or received
 * a message on. This is the source of truth for "what can I send to" because:
 *
 *   - It survives container restarts (log.jsonl lives on R2)
 *   - It captures channels from any adapter, including ones with no
 *     enumerable membership API (Telegram bots, email)
 *   - It's the same data the agent sees in its own awareness stream
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ChannelListing {
	adapter: string;
	id: string;
	name: string;
	lastSeen: string;
}

export interface SlackThreadListing {
	adapter: "slack";
	channelId: string;
	channelName: string;
	threadTs: string;
	sendTarget: string;
	rootPreview: string;
	lastPreview: string;
	participants: string[];
	messageCount: number;
	lastSeen: string;
}

export interface LogEntry {
	channel?: string;
	channelId?: string;
	date?: string;
	ts?: string;
	threadTs?: string;
	text?: string;
	user?: string;
	userName?: string;
	displayName?: string;
	isBot?: boolean;
	directlyAddressed?: boolean;
	sourceEventType?: string;
}

function sendTargetForChannel(channel: ChannelListing): string {
	if (channel.adapter === "discord" && /^\d{17,20}$/.test(channel.id)) {
		return `discord:${channel.id}`;
	}
	return channel.id;
}

export function readLogEntries(workingDir: string): LogEntry[] {
	const logPath = join(workingDir, "log.jsonl");
	if (!existsSync(logPath)) return [];

	let raw: string;
	try {
		raw = readFileSync(logPath, "utf-8");
	} catch {
		return [];
	}

	const entries: LogEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Ignore malformed historical rows.
		}
	}
	return entries;
}

function preview(text: unknown, maxLength = 96): string {
	if (typeof text !== "string") return "";
	const normalized = text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

export function displayNameForEntry(entry: LogEntry): string {
	if (entry.isBot) return "Zip";
	return entry.displayName || entry.userName || entry.user || "unknown";
}

/**
 * Parse log.jsonl and extract the unique channels the agent has touched.
 *
 * Each log line that has both `channel` and `channelId` represents a real
 * platform interaction. We dedupe by `channelId` and keep the most recent
 * `channel` label and timestamp.
 *
 * The `channel` field is formatted `<adapter>:<name>` (e.g. `telegram:DM:Alex`,
 * `slack:#general`, `email-foo@bar.com`). We split on the first `:` to get
 * the adapter name; everything after is the human-readable label.
 */
export function collectChannelsFromLog(workingDir: string): ChannelListing[] {
	const byId = new Map<string, ChannelListing>();
	for (const entry of readLogEntries(workingDir)) {
		const { channel, channelId, date } = entry;
		if (!channel || !channelId) continue;

		// Split "<adapter>:<name>" — email-* has no colon, treat the whole thing as adapter
		const colonIdx = channel.indexOf(":");
		const adapter = colonIdx === -1 ? channel.split("-")[0] : channel.slice(0, colonIdx);
		const name = colonIdx === -1 ? channel : channel.slice(colonIdx + 1);

		const existing = byId.get(channelId);
		if (!existing || (date && date > existing.lastSeen)) {
			byId.set(channelId, { adapter, id: channelId, name, lastSeen: date ?? "" });
		}
	}

	return Array.from(byId.values()).sort((a, b) => {
		if (a.adapter !== b.adapter) return a.adapter.localeCompare(b.adapter);
		return a.name.localeCompare(b.name);
	});
}

/** Extract recent Slack thread roots as concrete send_message targets. */
export function collectSlackThreadsFromLog(workingDir: string, limit = 20): SlackThreadListing[] {
	const byTarget = new Map<string, SlackThreadListing & { participantSet: Set<string> }>();

	for (const entry of readLogEntries(workingDir)) {
		const channel = entry.channel;
		const channelId = entry.channelId;
		if (!channel || !channelId || !channel.startsWith("slack:") || channelId.startsWith("D")) continue;

		const threadTs = entry.threadTs || entry.ts;
		if (!threadTs || !/^\d+\.\d+$/.test(threadTs)) continue;

		const channelName = channel.startsWith("slack:#") ? channel.slice("slack:#".length) : channel.slice("slack:".length);
		const sendTarget = `slack:${channelId}:${threadTs}`;
		const existing = byTarget.get(sendTarget);
		const linePreview = preview(entry.text);
		const participant = displayNameForEntry(entry);

		if (!existing) {
			byTarget.set(sendTarget, {
				adapter: "slack",
				channelId,
				channelName,
				threadTs,
				sendTarget,
				rootPreview: entry.ts === threadTs ? linePreview : "",
				lastPreview: linePreview,
				participants: [],
				participantSet: new Set([participant]),
				messageCount: 1,
				lastSeen: entry.date || "",
			});
			continue;
		}

		if (entry.ts === threadTs && linePreview) existing.rootPreview = linePreview;
		if (participant) existing.participantSet.add(participant);
		existing.messageCount += 1;
		if (!existing.lastSeen || (entry.date && entry.date > existing.lastSeen)) {
			existing.lastSeen = entry.date || existing.lastSeen;
			existing.lastPreview = linePreview || existing.lastPreview;
		}
	}

	return Array.from(byTarget.values())
		.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
		.slice(0, limit)
		.map(({ participantSet, ...thread }) => ({
			...thread,
			participants: Array.from(participantSet).slice(0, 4),
			rootPreview: thread.rootPreview || thread.lastPreview || "(no text captured)",
			lastPreview: thread.lastPreview || thread.rootPreview || "(no text captured)",
		}));
}

/** Format channel and thread listings as markdown tables for human/agent consumption. */
export function formatChannelTable(channels: ChannelListing[], slackThreads: SlackThreadListing[] = []): string {
	const sections: string[] = [];

	if (channels.length === 0) {
		sections.push("No channels yet - the agent has not sent or received any messages.");
	} else {
		sections.push([
			"Channels:",
			"| Adapter | Channel ID | Send Target | Name | Last Seen |",
			"|---------|------------|-------------|------|-----------|",
			...channels.map((c) => `| ${c.adapter} | \`${c.id}\` | \`${sendTargetForChannel(c)}\` | ${c.name} | ${c.lastSeen || "-"} |`),
		].join("\n"));
	}

	if (slackThreads.length > 0) {
		sections.push([
			"Recent Slack thread targets:",
			"| Channel | Send Target | Root / Subject | Latest Message | Participants | Last Seen |",
			"|---------|-------------|----------------|----------------|--------------|-----------|",
			...slackThreads.map((t) => `| #${t.channelName} | \`${t.sendTarget}\` | ${t.rootPreview} | ${t.lastPreview} | ${t.participants.join(", ") || "-"} (${t.messageCount}) | ${t.lastSeen || "-"} |`),
		].join("\n"));
	}

	return sections.join("\n\n");
}

export function createListChannelsTool(workingDir: string): AgentTool<any> {
	const schema = Type.Object({});

	return {
		name: "list_channels",
		label: "list_channels",
		description:
			"List every channel the agent has ever sent or received a message on, plus recent Slack thread targets. " +
			"Reads from log.jsonl, so it covers all adapters (Telegram, Slack, Email, " +
			"Discord, SMS/iMessage, etc.) and survives container restarts. Use this to discover valid " +
			"send_message targets, including slack:<channel>:<thread_ts> when choosing among Slack threads.",
		parameters: schema,
		execute: async () => {
			const channels = collectChannelsFromLog(workingDir);
			const slackThreads = collectSlackThreadsFromLog(workingDir);
			return {
				content: [{ type: "text" as const, text: formatChannelTable(channels, slackThreads) }],
				details: undefined,
			};
		},
	};
}
