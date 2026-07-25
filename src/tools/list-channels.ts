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
import type { PlatformAdapter, SlackThreadTargetInfo } from "../adapters/types.js";
import { collectEmailThreadListings, type EmailThreadListing } from "../adapters/email/thread-ledger.js";

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
	source?: "slack-api" | "log";
}

export interface PhoneConversationListing {
	adapter: "phone";
	channelId: string;
	sendTarget: string;
	displayName: string;
	transport: string;
	participants: string[];
	lastPreview: string;
	messageCount: number;
	lastSeen: string;
	source: "phone-registry";
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
	provider?: string;
	transport?: string;
}

interface PhoneChannelRegistryFile {
	version?: number;
	channels?: Record<string, {
		channelId?: string;
		transport?: string;
		conversationId?: string;
		participants?: string[];
		displayName?: string;
		updatedAt?: string;
	}>;
}

function sendTargetForChannel(channel: ChannelListing): string {
	if (channel.adapter === "discord" && /^\d{17,20}$/.test(channel.id)) {
		return `discord:${channel.id}`;
	}
	if (channel.adapter === "mattermost" && /^[a-z0-9]{26}$/.test(channel.id)) {
		return `mattermost:${channel.id}`;
	}
	if (channel.adapter === "rocket-chat" && /^[A-Za-z0-9_-]+$/.test(channel.id)) {
		return `rocket-chat:${channel.id}`;
	}
	if (channel.adapter === "zulip" && /^[1-9]\d*$/.test(channel.id)) {
		return `zulip:${channel.id}`;
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
	if (entry.isBot) return "Agent";
	return entry.displayName || entry.userName || entry.user || "unknown";
}

/**
 * Parse log.jsonl and extract the unique channels the agent has touched.
 *
 * Each log line that has both `channel` and `channelId` represents a real
 * platform interaction. We dedupe by `channelId` and keep the most recent
 * `channel` label and timestamp.
 *
 * The `channel` field is formatted `<adapter>:<name>` (e.g. `telegram:DM:Casey`,
 * `slack:#general`, `email-user@example.com`). We split on the first `:` to get
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

/** Merge channels currently advertised by connected adapters with durable log history. */
export function collectChannels(workingDir: string, adapters: PlatformAdapter[] = []): ChannelListing[] {
	const byTarget = new Map<string, ChannelListing>();
	for (const channel of collectChannelsFromLog(workingDir)) {
		byTarget.set(`${channel.adapter}:${channel.id}`, channel);
	}
	for (const adapter of adapters) {
		for (const channel of adapter.getAllChannels()) {
			if (!channel?.id) continue;
			const key = `${adapter.name}:${channel.id}`;
			const historical = byTarget.get(key);
			byTarget.set(key, {
				adapter: adapter.name,
				id: channel.id,
				name: channel.name || historical?.name || channel.id,
				lastSeen: historical?.lastSeen || "",
			});
		}
	}
	return Array.from(byTarget.values()).sort((a, b) => {
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
				source: "log",
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

export async function collectSlackThreads(
	workingDir: string,
	adapters: PlatformAdapter[] = [],
	limit = 20,
): Promise<SlackThreadListing[]> {
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
	const byTarget = new Map<string, SlackThreadListing>();

	const slack = adapters.find((adapter) => adapter.name === "slack" && typeof adapter.listThreads === "function");
	if (slack?.listThreads) {
		try {
			for (const thread of await slack.listThreads(boundedLimit)) {
				byTarget.set(thread.sendTarget, normalizeSlackThreadListing(thread, "slack-api"));
			}
		} catch {
			// Keep log fallback below. Individual Slack channel failures are logged by the adapter.
		}
	}

	for (const thread of collectSlackThreadsFromLog(workingDir, boundedLimit)) {
		if (!byTarget.has(thread.sendTarget)) byTarget.set(thread.sendTarget, normalizeSlackThreadListing(thread, "log"));
	}

	return Array.from(byTarget.values())
		.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
		.slice(0, boundedLimit);
}

function normalizeSlackThreadListing(thread: SlackThreadTargetInfo | SlackThreadListing, source: "slack-api" | "log"): SlackThreadListing {
	return {
		adapter: "slack",
		channelId: thread.channelId,
		channelName: preview(thread.channelName, 40) || thread.channelId,
		threadTs: thread.threadTs,
		sendTarget: thread.sendTarget,
		rootPreview: preview(thread.rootPreview) || "(no text captured)",
		lastPreview: preview(thread.lastPreview || thread.rootPreview) || "(no text captured)",
		participants: (thread.participants || []).map((participant) => preview(participant, 40)).filter(Boolean).slice(0, 4),
		messageCount: Math.max(1, Number(thread.messageCount) || 1),
		lastSeen: thread.lastSeen || "",
		source: thread.source || source,
	};
}

export function collectPhoneConversations(workingDir: string, limit = 20): PhoneConversationListing[] {
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
	const registry = readPhoneRegistry(workingDir);
	const logEntries = readLogEntries(workingDir).filter((entry) => entry.channelId?.startsWith("phone-"));
	const byChannel = new Map<string, PhoneConversationListing>();

	for (const [channelId, record] of registry) {
		byChannel.set(channelId, {
			adapter: "phone",
			channelId,
			sendTarget: channelId,
			displayName: preview(record.displayName, 60) || channelId,
			transport: preview(record.transport, 20) || "phone",
			participants: (record.participants || []).map((participant) => preview(participant, 40)).filter(Boolean).slice(0, 8),
			lastPreview: "",
			messageCount: 0,
			lastSeen: record.updatedAt || "",
			source: "phone-registry",
		});
	}

	for (const entry of logEntries) {
		const channelId = entry.channelId;
		if (!channelId) continue;
		const existing = byChannel.get(channelId) || {
			adapter: "phone" as const,
			channelId,
			sendTarget: channelId,
			displayName: entry.channel?.startsWith("phone:") ? entry.channel.slice("phone:".length) : channelId,
			transport: preview(entry.transport, 20) || "phone",
			participants: [],
			lastPreview: "",
			messageCount: 0,
			lastSeen: "",
			source: "phone-registry" as const,
		};
		const sender = displayNameForEntry(entry);
		if (sender && sender !== "unknown" && !existing.participants.includes(sender)) {
			existing.participants = [...existing.participants, sender].slice(0, 8);
		}
		existing.messageCount += 1;
		if (!existing.lastSeen || (entry.date && entry.date > existing.lastSeen)) {
			existing.lastSeen = entry.date || existing.lastSeen;
			existing.lastPreview = preview(entry.text) || existing.lastPreview;
			existing.transport = preview(entry.transport, 20) || existing.transport;
		}
		byChannel.set(channelId, existing);
	}

	return Array.from(byChannel.values())
		.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
		.slice(0, boundedLimit)
		.map((conversation) => ({
			...conversation,
			lastPreview: conversation.lastPreview || "(no text captured)",
		}));
}

function readPhoneRegistry(workingDir: string): Map<string, NonNullable<PhoneChannelRegistryFile["channels"]>[string]> {
	const path = join(workingDir, "phone-channels.json");
	const out = new Map<string, NonNullable<PhoneChannelRegistryFile["channels"]>[string]>();
	if (!existsSync(path)) return out;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as PhoneChannelRegistryFile;
		for (const [channelId, record] of Object.entries(parsed.channels || {})) {
			out.set(record.channelId || channelId, record);
		}
	} catch {
		return out;
	}
	return out;
}

/** Format channel and thread listings as markdown tables for human/agent consumption. */
export function formatChannelTable(
	channels: ChannelListing[],
	slackThreads: SlackThreadListing[] = [],
	emailThreads: EmailThreadListing[] = [],
	phoneConversations: PhoneConversationListing[] = [],
): string {
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
			"| Channel | Send Target | Root / Subject | Latest Message | Participants | Last Seen | Source |",
			"|---------|-------------|----------------|----------------|--------------|-----------|--------|",
			...slackThreads.map((t) => `| #${t.channelName} | \`${t.sendTarget}\` | ${t.rootPreview} | ${t.lastPreview} | ${t.participants.join(", ") || "-"} (${t.messageCount}) | ${t.lastSeen || "-"} | ${t.source === "slack-api" ? "Slack API" : "local log"} |`),
		].join("\n"));
	}

	if (emailThreads.length > 0) {
		sections.push([
			"Recent email thread targets:",
			"| Send Target | Subject | Latest Message | Participants | Last Seen | Source |",
			"|-------------|---------|----------------|--------------|-----------|--------|",
			...emailThreads.map((t) => `| \`${t.sendTarget}\` | ${t.subject} | ${t.lastPreview} | ${t.participants.join(", ") || "-"} (${t.messageCount}) | ${t.lastSeen || "-"} | email ledger |`),
		].join("\n"));
	}

	if (phoneConversations.length > 0) {
		sections.push([
			"Recent phone conversation targets:",
			"| Transport | Send Target | Conversation | Latest Message | Participants | Last Seen |",
			"|-----------|-------------|--------------|----------------|--------------|-----------|",
			...phoneConversations.map((c) => `| ${c.transport} | \`${c.sendTarget}\` | ${c.displayName} | ${c.lastPreview} | ${c.participants.join(", ") || "-"} (${c.messageCount}) | ${c.lastSeen || "-"} |`),
		].join("\n"));
	}

	return sections.join("\n\n");
}

export function createListChannelsTool(workingDir: string, adapters: PlatformAdapter[] = []): AgentTool<any> {
	const schema = Type.Object({});

	return {
		name: "list_channels",
		label: "list_channels",
		description:
			"List every channel the agent has ever sent or received a message on, plus recent Slack, email, and phone conversation targets. " +
			"Uses Slack API for recent Slack thread targets when available and log.jsonl as durable fallback. " +
			"Reads channels from log.jsonl, so it covers all adapters (Telegram, Slack, Rocket.Chat, Mattermost, Email, " +
			"Discord, SMS/iMessage, etc.) and survives container restarts. Use this to discover valid " +
			"send_message targets, including rocket-chat:<room>, mattermost:<channel>, slack:<channel>:<thread_ts>, email-thread:<id>, and phone-... when choosing among conversations.",
		parameters: schema,
		execute: async () => {
			const channels = collectChannels(workingDir, adapters);
			const slackThreads = await collectSlackThreads(workingDir, adapters);
			const emailThreads = collectEmailThreadListings(workingDir);
			const phoneConversations = collectPhoneConversations(workingDir);
			return {
				content: [{ type: "text" as const, text: formatChannelTable(channels, slackThreads, emailThreads, phoneConversations) }],
				details: undefined,
			};
		},
	};
}
