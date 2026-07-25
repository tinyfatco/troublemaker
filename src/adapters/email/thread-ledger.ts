import { appendFileSync, existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { normalizeMessageIdForHeader, parseReferencesHeader } from "./thread-headers.js";

export interface EmailThreadLedgerEvent {
	type: "inbound" | "outbound";
	at: string;
	channelId: string;
	from?: string;
	to?: string[];
	subject?: string;
	body?: string;
	messageId?: string;
	providerMessageId?: string;
	providerThreadId?: string;
	deliveryId?: string;
	hostContextId?: string;
	inReplyTo?: string;
	references?: string;
}

const LEDGER_FILE = "email-thread-events.jsonl";
const EMAIL_THREAD_TARGET_RE = /^email-thread:([a-f0-9]{16})$/i;
const EMAIL_PROVIDER_CHANNEL_RE = /^email-thread-([a-f0-9]{16})$/i;

export function appendEmailThreadEvent(workingDir: string, event: EmailThreadLedgerEvent): void {
	appendFileSync(join(workingDir, LEDGER_FILE), `${JSON.stringify(event)}\n`);
}

export interface EmailThreadTargetParts {
	threadId: string;
	inputTarget: string;
}

export interface EmailThreadLedgerRecord extends EmailThreadLedgerEvent {
	threadKey: string;
	threadId: string;
}

export interface EmailThreadListing {
	adapter: "email";
	threadId: string;
	sendTarget: string;
	subject: string;
	rootPreview: string;
	lastPreview: string;
	participants: string[];
	messageCount: number;
	lastSeen: string;
	source: "email-ledger";
}

export function parseEmailThreadTarget(target: string): EmailThreadTargetParts | null {
	const match = target.trim().match(EMAIL_THREAD_TARGET_RE);
	if (!match) return null;
	return {
		threadId: match[1].toLowerCase(),
		inputTarget: `email-thread:${match[1].toLowerCase()}`,
	};
}

export function emailThreadKeyForEvent(event: Pick<EmailThreadLedgerEvent, "channelId" | "subject" | "messageId" | "inReplyTo" | "references">): string {
	const references = parseReferencesHeader(event.references);
	const rootReference = references[0];
	if (rootReference) return `message:${messageIdKey(rootReference)}`;

	const inReplyTo = normalizeMessageIdForHeader(event.inReplyTo);
	if (inReplyTo) return `message:${messageIdKey(inReplyTo)}`;

	const messageId = normalizeMessageIdForHeader(event.messageId);
	if (messageId) return `message:${messageIdKey(messageId)}`;

	return `fallback:${event.channelId}:${normalizeSubject(event.subject)}`;
}

export function emailThreadIdForKey(threadKey: string): string {
	return createHash("sha256").update(threadKey).digest("hex").slice(0, 16);
}

export function emailThreadIdForEvent(event: Pick<EmailThreadLedgerEvent, "channelId" | "subject" | "messageId" | "providerThreadId" | "inReplyTo" | "references">): string {
	const providerThreadId = nativeProviderThreadId(event);
	return providerThreadId || emailThreadIdForKey(emailThreadKeyForEvent(event));
}

function nativeProviderThreadId(event: Pick<EmailThreadLedgerEvent, "channelId" | "providerThreadId">): string | undefined {
	const explicit = event.providerThreadId?.trim().toLowerCase();
	if (explicit && /^[a-f0-9]{16}$/.test(explicit)) return explicit;
	return event.channelId.match(EMAIL_PROVIDER_CHANNEL_RE)?.[1].toLowerCase();
}

export function readEmailThreadLedger(workingDir: string): EmailThreadLedgerRecord[] {
	const path = join(workingDir, LEDGER_FILE);
	if (!existsSync(path)) return [];

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return [];
	}

	const records: EmailThreadLedgerRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as EmailThreadLedgerEvent;
			if (!event || typeof event !== "object" || !event.type || !event.channelId) continue;
			const threadKey = emailThreadKeyForEvent(event);
			records.push({
				...event,
				threadKey,
				threadId: emailThreadIdForEvent(event),
			});
		} catch {
			// Ignore malformed historical rows.
		}
	}
	return records;
}

export function collectEmailThreadListings(workingDir: string, limit = 20): EmailThreadListing[] {
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
	const byThread = new Map<string, EmailThreadListing & { participantSet: Set<string>; firstSeen: string }>();

	for (const event of readEmailThreadLedger(workingDir)) {
		const existing = byThread.get(event.threadId);
		const bodyPreview = preview(event.body);
		const participantSet = existing?.participantSet || new Set<string>();
		for (const participant of participantsForEvent(event)) participantSet.add(participant);

		if (!existing) {
			byThread.set(event.threadId, {
				adapter: "email",
				threadId: event.threadId,
				sendTarget: `email-thread:${event.threadId}`,
				subject: preview(event.subject, 80) || "(no subject)",
				rootPreview: bodyPreview,
				lastPreview: bodyPreview,
				participants: [],
				participantSet,
				messageCount: 1,
				firstSeen: event.at || "",
				lastSeen: event.at || "",
				source: "email-ledger",
			});
			continue;
		}

		existing.messageCount += 1;
		if (bodyPreview && (!existing.rootPreview || (event.at && event.at < existing.firstSeen))) {
			existing.rootPreview = bodyPreview;
			existing.firstSeen = event.at || existing.firstSeen;
		}
		if (!existing.lastSeen || (event.at && event.at > existing.lastSeen)) {
			existing.lastSeen = event.at || existing.lastSeen;
			existing.lastPreview = bodyPreview || existing.lastPreview;
			existing.subject = preview(event.subject, 80) || existing.subject;
		}
	}

	return Array.from(byThread.values())
		.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
		.slice(0, boundedLimit)
		.map(({ participantSet, firstSeen: _firstSeen, ...thread }) => ({
			...thread,
			rootPreview: thread.rootPreview || thread.lastPreview || "(no body captured)",
			lastPreview: thread.lastPreview || thread.rootPreview || "(no body captured)",
			participants: Array.from(participantSet).slice(0, 6),
		}));
}

export function readEmailThreadById(workingDir: string, threadId: string, limit = 40): EmailThreadLedgerRecord[] {
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 40, 100));
	return readEmailThreadLedger(workingDir)
		.filter((event) => event.threadId === threadId)
		.sort((a, b) => (a.at || "").localeCompare(b.at || ""))
		.slice(-boundedLimit);
}

export function latestInboundEmailThreadEvent(workingDir: string, threadId: string): EmailThreadLedgerRecord | undefined {
	return readEmailThreadLedger(workingDir)
		.filter((event) => event.threadId === threadId && event.type === "inbound" && event.from)
		.sort((a, b) => (b.at || "").localeCompare(a.at || ""))
		[0];
}

function normalizeSubject(subject?: string): string {
	return (subject || "")
		.trim()
		.replace(/^(?:\s*(?:re|fwd):)+\s*/i, "")
		.toLowerCase();
}

function messageIdKey(messageId: string): string {
	const normalized = normalizeMessageIdForHeader(messageId) || messageId.trim();
	const inner = normalized.startsWith("<") && normalized.endsWith(">")
		? normalized.slice(1, -1)
		: normalized;
	const at = inner.lastIndexOf("@");
	if (at === -1) return inner;
	return `${inner.slice(0, at)}@${inner.slice(at + 1).toLowerCase()}`;
}

function preview(text: unknown, maxLength = 96): string {
	if (typeof text !== "string") return "";
	const normalized = text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

function participantsForEvent(event: EmailThreadLedgerEvent): string[] {
	return [
		event.from,
		...(event.to || []),
	]
		.map((value) => value?.trim().toLowerCase())
		.filter((value): value is string => Boolean(value));
}
