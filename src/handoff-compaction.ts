import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const HANDOFF_OPEN = "<troublemaker_private_handoff>";
export const HANDOFF_CLOSE = "</troublemaker_private_handoff>";
export const HANDOFF_JOURNAL_VERSION = 1;
export const HANDOFF_CUSTOM_TYPE = "troublemaker.continuity-handoff.v1";
export const MAX_HANDOFF_BYTES = 64 * 1024;
export const MAX_HANDOFF_ITEMS = 200;
export const MAX_HANDOFF_STRING_LENGTH = 8 * 1024;

export interface StructuredHandoff {
	version: 1;
	goal: string;
	constraints: string[];
	completed: string[];
	inProgress: string[];
	nextSteps: string[];
	decisions: Array<{ decision: string; rationale: string }>;
	provenance: Array<{ claim: string; source: string }>;
	uncertainties: string[];
	superseded: Array<{ previous: string; replacement: string }>;
	toolReceipts: Array<{ tool: string; result: string }>;
	routing: { channel: string; replyTarget: string | null };
}

export interface HandoffRotationJournal {
	version: 1;
	id: string;
	createdAt: string;
	archivePath: string;
	handoff: StructuredHandoff;
	tail: AgentMessage[];
}

export function handoffInstruction(channel: string, replyTarget?: string): string {
	return `PRIVATE CONTINUITY CHECKPOINT REQUIRED. Finish the user's substantive work first. At the absolute end of this same assistant turn, append exactly one ${HANDOFF_OPEN} JSON ${HANDOFF_CLOSE} block. Do not mention or explain the block. The JSON must match this schema exactly: {"version":1,"goal":"string","constraints":["string"],"completed":["string"],"inProgress":["string"],"nextSteps":["string"],"decisions":[{"decision":"string","rationale":"string"}],"provenance":[{"claim":"string","source":"string"}],"uncertainties":["string"],"superseded":[{"previous":"string","replacement":"string"}],"toolReceipts":[{"tool":"string","result":"string"}],"routing":{"channel":${JSON.stringify(channel)},"replyTarget":${JSON.stringify(replyTarget || null)}}}. Preserve exact identifiers and paths only when necessary for continuity; never include credentials, secrets, hidden reasoning, or unrelated personal data.`;
}

function longestDelimiterPrefixSuffix(text: string): number {
	const max = Math.min(text.length, HANDOFF_OPEN.length - 1);
	for (let length = max; length > 0; length--) {
		if (text.endsWith(HANDOFF_OPEN.slice(0, length))) return length;
	}
	return 0;
}

/** Project model text to public output while withholding delimiter fragments. */
export function projectPublicHandoffText(text: string, terminal = false): string {
	const start = text.indexOf(HANDOFF_OPEN);
	if (start >= 0) return text.slice(0, start);
	const withheld = longestDelimiterPrefixSuffix(text);
	return withheld > 0 ? text.slice(0, -withheld) : text;
}

export function projectPublicHandoffParts(parts: string[], terminal = false): string[] {
	const visible = projectPublicHandoffText(parts.join(""), terminal);
	let remaining = visible.length;
	return parts.map((part) => {
		if (remaining <= 0) return "";
		const kept = part.slice(0, remaining);
		remaining -= kept.length;
		return kept;
	});
}

/** Join public text with the established separator without retaining private tail parts. */
export function joinPublicHandoffParts(parts: string[], terminal = false): string {
	const projected = projectPublicHandoffParts(parts, terminal);
	const visibleLength = projected.reduce((total, part) => total + part.length, 0);
	const kept: string[] = [];
	let consumed = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (consumed < visibleLength) {
			kept.push(projected[index]);
			consumed += part.length;
			continue;
		}
		if (part.length === 0) {
			kept.push("");
			continue;
		}
		break;
	}
	return kept.join("\n");
}

function boundedString(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_HANDOFF_STRING_LENGTH;
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= MAX_HANDOFF_ITEMS && value.every(boundedString);
}

function boundedObjects(value: unknown, fields: string[]): value is Array<Record<string, string>> {
	return Array.isArray(value) && value.length <= MAX_HANDOFF_ITEMS && value.every((entry) =>
		entry && typeof entry === "object" && !Array.isArray(entry)
		&& fields.every((field) => boundedString((entry as Record<string, unknown>)[field])));
}

export function extractStructuredHandoff(
	text: string,
	authoritativeRouting?: StructuredHandoff["routing"],
): { publicText: string; handoff: StructuredHandoff } | null {
	const start = text.indexOf(HANDOFF_OPEN);
	if (start < 0) return null;
	const end = text.indexOf(HANDOFF_CLOSE, start + HANDOFF_OPEN.length);
	if (end < 0 || text.slice(end + HANDOFF_CLOSE.length).trim()) return null;
	const serialized = text.slice(start + HANDOFF_OPEN.length, end).trim();
	if (Buffer.byteLength(serialized, "utf8") > MAX_HANDOFF_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const h = value as Record<string, unknown>;
	const decisions = h.decisions;
	const provenance = h.provenance;
	const superseded = h.superseded;
	const receipts = h.toolReceipts;
	const routing = h.routing as Record<string, unknown> | undefined;
	if (h.version !== 1 || !boundedString(h.goal)
		|| !strings(h.constraints) || !strings(h.completed) || !strings(h.inProgress) || !strings(h.nextSteps)
		|| !strings(h.uncertainties)
		|| !boundedObjects(decisions, ["decision", "rationale"])
		|| !boundedObjects(provenance, ["claim", "source"])
		|| !boundedObjects(superseded, ["previous", "replacement"])
		|| !boundedObjects(receipts, ["tool", "result"])
		|| !routing || !boundedString(routing.channel)
		|| !(routing.replyTarget === null || boundedString(routing.replyTarget))) return null;
	const handoff = value as StructuredHandoff;
	if (authoritativeRouting) handoff.routing = { ...authoritativeRouting };
	return { publicText: text.slice(0, start), handoff };
}

export function shouldRequestHandoff(contextTokens: number, contextWindow: number, reserveTokens: number, keepRecentTokens: number): boolean {
	if (contextTokens <= 0 || contextWindow <= 0) return false;
	return contextTokens >= Math.max(1, contextWindow - reserveTokens - keepRecentTokens);
}

function messageChars(message: AgentMessage): number {
	return JSON.stringify(message).length;
}

/** Retain whole messages and begin at a user boundary; never cut a tool exchange. */
export function selectCompleteRecentTail(messages: AgentMessage[], keepRecentTokens: number): AgentMessage[] {
	const budget = Math.max(1, keepRecentTokens) * 4;
	let start = messages.length;
	let chars = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		chars += messageChars(messages[index]);
		start = index;
		if (chars >= budget) break;
	}
	while (start > 0 && messages[start]?.role !== "user") start--;
	return messages.slice(start);
}

export function sanitizeHandoffMessage(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	const textParts = message.content.filter((part) => part.type === "text").map((part) => part.text);
	const projected = projectPublicHandoffParts(textParts, true);
	let textIndex = 0;
	return {
		...message,
		content: message.content.map((part) => part.type === "text"
			? { ...part, text: projected[textIndex++] }
			: part),
	} as AgentMessage;
}

/** Sanitize a persisted Pi session line before it reaches awareness/UI surfaces. */
export function sanitizePrivateHandoffSessionLine(line: string): string {
	try {
		const entry = JSON.parse(line) as { type?: unknown; message?: AgentMessage };
		if (entry.type !== "message" || !entry.message || entry.message.role !== "assistant") return line;
		const sanitized = sanitizeHandoffMessage(entry.message);
		return JSON.stringify(sanitized) === JSON.stringify(entry.message)
			? line
			: JSON.stringify({ ...entry, message: sanitized });
	} catch {
		return line.includes(HANDOFF_OPEN[0])
			? JSON.stringify({ type: "custom", customType: "troublemaker.private-handoff-redacted", display: false })
			: line;
	}
}

export function writeHandoffJournal(path: string, journal: HandoffRotationJournal): void {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

export function readHandoffJournal(path: string): HandoffRotationJournal | null {
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as HandoffRotationJournal;
		return value.version === HANDOFF_JOURNAL_VERSION && Array.isArray(value.tail) && value.handoff?.version === 1 ? value : null;
	} catch {
		return null;
	}
}

export async function archiveForHandoff(contextFile: string, archivePath: string): Promise<void> {
	await mkdir(dirname(archivePath), { recursive: true });
	if (!existsSync(archivePath) && existsSync(contextFile)) await copyFile(contextFile, archivePath);
}

export async function replayHandoffRotation(
	contextFile: string,
	awarenessDir: string,
	journalPath: string,
	journal: HandoffRotationJournal,
): Promise<void> {
	await archiveForHandoff(contextFile, journal.archivePath);
	writeFileSync(contextFile, "", { encoding: "utf8", mode: 0o600 });
	const fresh = SessionManager.open(contextFile, awarenessDir);
	fresh.appendCustomMessageEntry(
		HANDOFF_CUSTOM_TYPE,
		`Private continuity handoff from the prior context:\n${JSON.stringify(journal.handoff)}`,
		false,
		{ version: 1, journalId: journal.id },
	);
	for (const message of journal.tail) fresh.appendMessage(message as Parameters<typeof fresh.appendMessage>[0]);
	removeHandoffJournal(journalPath);
}

export function removeHandoffJournal(path: string): void {
	if (existsSync(path)) unlinkSync(path);
}

export function handoffJournalPath(awarenessDir: string): string {
	return join(awarenessDir, "handoff-rotation.json");
}
