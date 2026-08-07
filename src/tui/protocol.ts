import type {
	RuntimeAssistantSnapshotContent,
	RuntimeAssistantSnapshotEntry,
	RuntimeStreamEvent,
} from "../core/runtime-contract.js";
import {
	parseInterruptBatchMessages as parseVisibleInterruptBatchMessages,
	parseUserPromptEnvelope,
	parseVisibleUserInputs,
	stripModelContextBlocks,
} from "../user-input-display.js";

export interface TuiHistoryEntry {
	id: string;
	parentId?: string;
	timestamp: string;
	role: "user" | "assistant" | "toolResult";
	content: RuntimeAssistantSnapshotContent[];
	channel?: string;
	userName?: string;
	text?: string;
	model?: string;
	stopReason?: string;
	isAmbient?: boolean;
	batchedUserEntries?: TuiBatchedUserEntry[];
}

export interface TuiBatchedUserEntry {
	channel: string;
	userName: string;
	text: string;
}

export async function* readRuntimeSse(response: Response): AsyncGenerator<RuntimeStreamEvent> {
	for await (const data of readSseData(response)) {
		if (data === "[DONE]") return;
		const event = parseRuntimeEvent(data);
		if (event) yield event;
	}
}

export async function* readSseData(response: Response): AsyncGenerator<string> {
	if (!response.ok) {
		const detail = (await response.text()).replace(/\s+/g, " ").trim();
		throw new Error(`Agent request failed (${response.status})${detail ? `: ${detail.substring(0, 400)}` : ""}`);
	}
	if (!response.body) throw new Error("Agent response did not include a stream");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			const parsed = drainSseBuffer(buffer, done);
			buffer = parsed.remainder;
			for (const data of parsed.data) {
				yield data;
			}
			if (done) return;
		}
	} finally {
		reader.releaseLock();
	}
}

export function parseContextLine(line: string): TuiHistoryEntry | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(raw) || raw.type !== "message" || !isRecord(raw.message)) return null;

	const role = raw.message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
	const content = normalizeContent(raw.message.content);
	const entry: TuiHistoryEntry = {
		id: stringValue(raw.id) || `message-${stringValue(raw.timestamp) || Date.now()}`,
		parentId: stringValue(raw.parentId) || undefined,
		timestamp: stringValue(raw.timestamp) || new Date().toISOString(),
		role,
		content,
		model: stringValue(raw.message.model) || stringValue(raw.model) || undefined,
		stopReason: stringValue(raw.message.stopReason) || stringValue(raw.stopReason) || undefined,
	};

	if (role === "user") {
		const text = content.find((block) => block.type === "text");
		if (text?.type === "text") {
			const slackUsers = extractSlackUsers(text.text);
			const visibleText = stripModelContextBlocks(text.text).trim();
			const envelope = parseUserPromptEnvelope(text.text);
			if (envelope?.text.startsWith("[AMBIENT]")) {
				applyAmbientDisplay(entry, envelope.text, slackUsers, normalizeChannelLabel(envelope.channel));
			} else if (envelope) {
				const inputs = parseVisibleUserInputs(text.text).map((input) => ({
					...input,
					channel: normalizeChannelLabel(input.channel),
				}));
				if (inputs.length > 1) entry.batchedUserEntries = inputs;
				else if (inputs[0]) {
					entry.channel = inputs[0].channel;
					entry.userName = inputs[0].userName;
					entry.text = inputs[0].text;
				}
			} else if (visibleText.startsWith("[AMBIENT]")) {
				// Same-thread ambient context can be soft-steered directly into an
				// active run, so Pi persists it without the normal timestamp/channel
				// envelope. Keep internal evaluation instructions out of the TUI and
				// surface only the already-posted messages inside the bounded block.
				applyAmbientDisplay(entry, visibleText, slackUsers);
			} else {
				entry.text = visibleText;
			}
		}
	}

	return entry;
}

export function parseInterruptBatchMessages(text: string): TuiBatchedUserEntry[] {
	return parseVisibleInterruptBatchMessages(text).map((entry) => ({
		...entry,
		channel: normalizeChannelLabel(entry.channel),
	}));
}

function applyAmbientDisplay(
	entry: TuiHistoryEntry,
	rawText: string,
	slackUsers: ReadonlyMap<string, string>,
	fallbackChannel?: string,
): void {
	entry.isAmbient = true;
	entry.channel = ambientChannelLabel(rawText) || fallbackChannel || "awareness";
	entry.userName = "ambient";
	entry.text = getAmbientDisplayLines(rawText)
		.map((displayLine) => resolveSlackUserMentions(displayLine, slackUsers))
		.join("\n");
}

export function normalizeChannelLabel(channel: string): string {
	const value = channel.trim();
	if (!value) return "unknown";
	if (value.startsWith("terminal:")) return value;
	if (value.startsWith("slack:")) return value;
	if (value.startsWith("telegram:")) return value;
	if (value.startsWith("discord:")) return value;
	if (value.startsWith("email:")) return value;
	if (value.startsWith("phone:")) return value;
	if (value.startsWith("#")) return `slack:${value}`;
	if (/^[CDG][A-Z0-9]+$/.test(value)) return `slack:#${value}`;
	if (/^-?\d+$/.test(value)) return `telegram:${value}`;
	if (value.startsWith("email-")) return "email";
	if (value.startsWith("phone-")) return "phone";
	return value;
}

export function getAmbientDisplayLines(rawText: string): string[] {
	const messageBlock = extractAmbientMessageBlock(rawText);
	if (!messageBlock) return [];
	return messageBlock
		.split("\n")
		.map((line) => cleanAmbientLineForDisplay(line))
		.filter(Boolean);
}

export function cleanAmbientLineForDisplay(line: string): string {
	return line
		.replace(/\s+\[Reply target:[^\]]+\]/g, "")
		.replace(/^([^:\n]+?)\s+\([A-Z0-9._-]+\)(?=:)/, "$1")
		.trim();
}

export function resolveSlackUserMentions(text: string, users: ReadonlyMap<string, string>): string {
	return text.replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (token, userId: string, fallback: string | undefined) => {
		const known = users.get(userId);
		if (known) return known;
		if (fallback?.trim()) return `@${fallback.trim().replace(/^@/, "")}`;
		return token;
	});
}

export function safeToolLabel(block: RuntimeAssistantSnapshotContent): string | undefined {
	if (block.type !== "toolCall") return undefined;
	const argumentLabel = typeof block.arguments?.label === "string" ? block.arguments.label.trim() : "";
	const label = block.label?.trim() || argumentLabel || block.name.trim();
	return label || undefined;
}

/**
 * Projects a cumulative assistant snapshot onto the visible content that
 * arrived after a transcript boundary. Thinking and raw tool output remain
 * intentionally absent from the terminal transcript.
 */
export function assistantContentDelta(
	current: RuntimeAssistantSnapshotContent[],
	baseline: RuntimeAssistantSnapshotContent[],
): RuntimeAssistantSnapshotContent[] {
	const baselineText = baseline.filter((block) => block.type === "text");
	const baselineToolCalls = new Set(baseline
		.filter((block) => block.type === "toolCall")
		.map((block) => block.type === "toolCall" ? block.id : ""));
	const baselineToolResults = new Map(baseline
		.filter((block) => block.type === "toolResult")
		.map((block) => block.type === "toolResult" ? [block.toolCallId, block] as const : ["", null] as const));
	const currentToolResults = new Map(current
		.filter((block) => block.type === "toolResult")
		.map((block) => block.type === "toolResult" ? [block.toolCallId, block] as const : ["", null] as const));
	const completedAfterBoundary = new Set<string>();
	for (const [toolCallId, result] of currentToolResults) {
		if (!result) continue;
		const previous = baselineToolResults.get(toolCallId);
		if (!previous || previous.result !== result.result || Boolean(previous.isError) !== Boolean(result.isError)) {
			completedAfterBoundary.add(toolCallId);
		}
	}

	const includedToolCalls = new Set<string>();
	const delta: RuntimeAssistantSnapshotContent[] = [];
	let textIndex = 0;
	for (const block of current) {
		if (block.type === "text") {
			const previous = baselineText[textIndex++];
			if (!previous) {
				delta.push(block);
			} else if (block.text.startsWith(previous.text)) {
				const suffix = block.text.slice(previous.text.length);
				if (suffix) delta.push({ ...block, text: suffix });
			} else if (block.text !== previous.text) {
				delta.push(block);
			}
			continue;
		}
		if (block.type === "toolCall") {
			if (!baselineToolCalls.has(block.id) || completedAfterBoundary.has(block.id)) {
				delta.push(block);
				includedToolCalls.add(block.id);
			}
			continue;
		}
		if (block.type === "toolResult" && includedToolCalls.has(block.toolCallId)) {
			delta.push(block);
		}
	}
	return delta;
}

/**
 * Returns true when one durable assistant turn is already represented inside
 * a cumulative live snapshot. Tool calls use their stable runtime IDs; text
 * uses exact visible content. Thinking, tool output, and results are ignored
 * because the terminal does not render them as assistant transcript content.
 */
export function isAssistantContentCoveredBySnapshot(
	durableContent: RuntimeAssistantSnapshotContent[],
	snapshotContent: RuntimeAssistantSnapshotContent[],
): boolean {
	if (durableContent.some((block) => block.type === "toolCall" && !block.id)) return false;
	const durableTokens = visibleAssistantTokens(durableContent);
	if (durableTokens.length === 0) return false;

	const available = new Map<string, number>();
	for (const token of visibleAssistantTokens(snapshotContent)) {
		available.set(token, (available.get(token) || 0) + 1);
	}
	for (const token of durableTokens) {
		const remaining = available.get(token) || 0;
		if (remaining === 0) return false;
		available.set(token, remaining - 1);
	}
	return true;
}

export function toAssistantSnapshot(event: RuntimeStreamEvent): RuntimeAssistantSnapshotEntry | null {
	if (event.type !== "assistant_snapshot") return null;
	return event.entry;
}

function drainSseBuffer(buffer: string, flush: boolean): { data: string[]; remainder: string } {
	const normalized = buffer.replace(/\r\n/g, "\n");
	const sections = normalized.split("\n\n");
	const remainder = flush ? "" : sections.pop() || "";
	const data: string[] = [];
	for (const section of sections) {
		const lines = section
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""));
		if (lines.length > 0) data.push(lines.join("\n"));
	}
	return { data, remainder };
}

function parseRuntimeEvent(data: string): RuntimeStreamEvent | null {
	try {
		const parsed = JSON.parse(data) as unknown;
		if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
		return parsed as unknown as RuntimeStreamEvent;
	} catch {
		return null;
	}
}

function normalizeContent(value: unknown): RuntimeAssistantSnapshotContent[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [];
	const content: RuntimeAssistantSnapshotContent[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.type !== "string") continue;
		if (item.type === "text") {
			content.push({
				type: "text",
				text: stringValue(item.text),
				contentIndex: numberValue(item.contentIndex),
			});
		} else if (item.type === "thinking") {
			content.push({
				type: "thinking",
				thinking: stringValue(item.thinking),
				thinkingSignature: stringValue(item.thinkingSignature) || undefined,
				contentIndex: numberValue(item.contentIndex),
			});
		} else if (["toolCall", "tool_call", "tool_use"].includes(item.type)) {
			const args = isRecord(item.arguments) ? item.arguments : isRecord(item.args) ? item.args : isRecord(item.input) ? item.input : {};
			const label = stringValue(item.label) || (typeof args.label === "string" ? args.label : "");
			content.push({
				type: "toolCall",
				id: stringValue(item.id) || stringValue(item.toolCallId) || stringValue(item.tool_call_id),
				name: stringValue(item.name) || stringValue(item.toolName) || "tool",
				...(label.trim() ? { label: label.trim() } : {}),
				arguments: args,
				contentIndex: numberValue(item.contentIndex),
			});
		} else if (["toolResult", "tool_result"].includes(item.type)) {
			const result = item.result ?? item.content ?? item.output ?? "";
			content.push({
				type: "toolResult",
				toolCallId: stringValue(item.toolCallId) || stringValue(item.tool_call_id),
				result: typeof result === "string" ? result : JSON.stringify(result),
				isError: Boolean(item.isError ?? item.is_error),
			});
		} else if (["toolOutput", "toolResultDelta", "tool_result_delta"].includes(item.type)) {
			content.push({
				type: "toolOutput",
				toolCallId: stringValue(item.toolCallId) || stringValue(item.tool_call_id),
				stream: item.stream === "stderr" || item.stream === "system" ? item.stream : "stdout",
				text: stringValue(item.text),
				pid: numberValue(item.pid),
				sequence: numberValue(item.sequence),
			});
		}
	}
	return content;
}

function visibleAssistantTokens(content: RuntimeAssistantSnapshotContent[]): string[] {
	const tokens: string[] = [];
	for (const block of content) {
		if (block.type === "toolCall" && block.id) {
			tokens.push(`tool:${block.id}`);
		} else if (block.type === "text" && block.text.trim()) {
			tokens.push(`text:${block.text.trim()}`);
		}
	}
	return tokens;
}

function extractSlackUsers(text: string): Map<string, string> {
	const users = new Map<string, string>();
	const sessionContext = text.match(/<session_context(?:\s[^>]*)?>([\s\S]*?)<\/session_context>/)?.[1];
	if (!sessionContext) return users;

	let readingUsers = false;
	for (const rawLine of sessionContext.split("\n")) {
		const line = rawLine.trim();
		if (line === "Users:") {
			readingUsers = true;
			continue;
		}
		if (!readingUsers) continue;
		if (/^[A-Za-z][^:]*:$/.test(line)) break;
		const [userId, handle] = line.split(/\s+/);
		if (/^U[A-Z0-9]+$/.test(userId || "") && handle?.startsWith("@")) users.set(userId, handle);
	}
	return users;
}

function extractAmbientMessageBlock(rawText: string): string {
	const tagged = rawText.match(/<ambient_messages>\s*([\s\S]*?)\s*<\/ambient_messages>/);
	if (tagged?.[1]) return tagged[1].trim();

	const ambientText = rawText.replace(/^\[AMBIENT\]\s*/, "").trim();
	const patterns = [
		/New unseen(?:, complete)? messages since your last ambient wake:\s*\n\n([\s\S]*?)(?:\n\nChannel pulse:|\n\nYou're observing|$)/,
		/Recent messages:\s*\n\n([\s\S]*?)(?:\n\nChannel pulse:|\n\nYou're observing|$)/,
	];
	for (const pattern of patterns) {
		const match = ambientText.match(pattern);
		if (match?.[1]) return match[1].trim();
	}
	return "";
}

function ambientChannelLabel(rawText: string): string | undefined {
	const match = rawText.match(/^\[AMBIENT\]\s+A conversation is happening in ([^.\n]+)\./);
	return match?.[1] ? normalizeChannelLabel(match[1]) : undefined;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
