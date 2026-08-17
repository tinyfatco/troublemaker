import type { RuntimeLiveEvent, RuntimeStreamEvent } from "../core/runtime-contract.js";

export type ConversationRole = "user" | "assistant";
export type ConversationAwarenessKind = "heartbeat" | "goal_continuation" | "follow_up";
export type ConversationToolState = "started" | "completed" | "failed";

export interface ConversationMessage {
	id: string;
	timestamp: string;
	role: ConversationRole;
	text: string;
	channel?: string;
	userName?: string;
	completionId?: string;
	deliveryId?: string;
	awarenessKind?: ConversationAwarenessKind;
	isError: boolean;
	speechEligible: boolean;
}

/**
 * A deliberately narrow activity projection for native conversation clients.
 * Tool identity, an explicitly human-readable label, and lifecycle are the
 * entire boundary. Arguments, output, results, and runtime topology never
 * enter this shape.
 */
export interface ConversationAwareness {
	id: string;
	timestamp: string;
	kind: "tool";
	label: string;
	state: ConversationToolState;
	sourceMessageId?: string;
}

export interface ConversationBacklog {
	messages: ConversationMessage[];
	awareness: ConversationAwareness[];
	total: number;
	offset: number;
}

interface ConversationLiveBase {
	sequence: number;
	streamId: string;
	id: string;
	timestamp: string;
	awareness?: ConversationAwareness[];
}

type ConversationLivePayload =
	| { kind: "message"; message: ConversationMessage }
	| { kind: "state"; runId: string; state: "thinking"; message?: string }
	| { kind: "assistant"; runId: string; completionId: string; text: string; isFinal: boolean; isError: boolean; speechEligible: boolean }
	| { kind: "error"; runId: string; message: string }
	| { kind: "completion"; runId: string; completionId: string }
	| { kind: "reset"; reason: "context_rotated" | "replay_gap" }
	| { kind: "cursor" };

export type ConversationLiveEvent = ConversationLiveBase & ConversationLivePayload;

const MODEL_CONTEXT_BLOCK_RE = /\s*<(session_context|delivery_context)>[\s\S]*?<\/\1>\s*/g;
const LEADING_MODEL_CONTEXTS_RE = /^(?:\s*<session_context>[\s\S]*?<\/session_context>\s*|\s*<delivery_context>[\s\S]*?<\/delivery_context>\s*)+/;
const DELIVERY_ID_RE = /<delivery_context>[\s\S]*?^Delivery ID:\s*([A-Za-z0-9._:-]{8,128})\s*$[\s\S]*?<\/delivery_context>/m;
const SOURCE_EVENT_RE = /<delivery_context>[\s\S]*?^Source event:\s*([A-Za-z0-9._:-]{1,128})\s*$[\s\S]*?<\/delivery_context>/m;
const USER_PREFIX_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/;
const ATTENTION_PREFIX_RE = /^\[ATTENTION:[^\]]+\]\s*/;
const FOLLOW_UP_HEADER_RE = /^\[FOLLOW_UP\s+\d+\/\d+\s+after\s+[^\]]+\]/;
const SAFE_TOOL_LABEL_LIMIT = 160;

/**
 * Project one durable awareness line onto the mobile conversation boundary.
 * Only exact user/assistant text survives. Thinking, tools, signatures, model
 * metadata, and unknown content never leave the resident through this view.
 */
export function projectConversationLine(line: string): ConversationMessage | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(raw) || raw.type !== "message" || !isRecord(raw.message)) return null;

	const role = raw.message.role;
	if (role !== "user" && role !== "assistant") return null;
	const sourceParts = Array.isArray(raw.message.content)
		? raw.message.content.flatMap((block): string[] =>
			isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])
		: [];
	if (sourceParts.length === 0) return null;

	let text = sourceParts.join("");
	let channel: string | undefined;
	let userName: string | undefined;
	let deliveryId: string | undefined;
	let awarenessKind: ConversationAwarenessKind | undefined;
	if (role === "user") {
		const leadingContexts = text.match(LEADING_MODEL_CONTEXTS_RE)?.[0] || "";
		deliveryId = leadingContexts.match(DELIVERY_ID_RE)?.[1];
		const sourceEventType = leadingContexts.match(SOURCE_EVENT_RE)?.[1];
		text = text.replace(MODEL_CONTEXT_BLOCK_RE, "").trim();
		const match = text.match(USER_PREFIX_RE);
		if (match) {
			channel = match[2].trim() || undefined;
			userName = match[3].trim() || undefined;
			text = match[4];
		}
		awarenessKind = classifyAwareness(sourceEventType, channel);
		if (awarenessKind === "follow_up") text = safeFollowUpText(text);
	}
	if (!text) return null;

	const id = stringValue(raw.id) || `message-${stringValue(raw.timestamp) || "unknown"}`;
	const stopReason = stringValue(raw.message.stopReason) || stringValue(raw.stopReason);
	const isError = role === "assistant" && stopReason === "error";
	return {
		id,
		timestamp: stringValue(raw.timestamp),
		role,
		text,
		...(channel ? { channel } : {}),
		...(userName ? { userName } : {}),
		...(deliveryId ? { deliveryId } : {}),
		...(awarenessKind ? { awarenessKind } : {}),
		...(role === "assistant" ? { completionId: id } : {}),
		isError,
		speechEligible: role === "assistant" && !isError,
	};
}

export function projectConversationBacklog(
	backlog: { lines: string[]; total: number; offset: number },
): ConversationBacklog {
	const messages: ConversationMessage[] = [];
	const awareness: ConversationAwareness[] = [];
	for (const line of backlog.lines) {
		const message = projectConversationLine(line);
		if (message) messages.push(message);
		awareness.push(...projectConversationAwarenessLine(line));
	}
	return {
		messages,
		awareness: reconcileConversationAwareness(awareness),
		total: backlog.total,
		offset: backlog.offset,
	};
}

/** Project durable tool lifecycle without forwarding any tool payload. */
export function projectConversationAwarenessLine(line: string): ConversationAwareness[] {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return [];
	}
	if (!isRecord(raw) || raw.type !== "message" || !isRecord(raw.message)) return [];

	const timestamp = stringValue(raw.timestamp);
	const sourceMessageId = stringValue(raw.id) || undefined;
	const role = stringValue(raw.message.role);
	if (role === "assistant") {
		const content = Array.isArray(raw.message.content) ? raw.message.content : [];
		return projectToolContent(content, timestamp, sourceMessageId);
	}
	if (role === "toolResult") {
		const toolCallId = firstString(raw.message.toolCallId, raw.message.tool_call_id);
		if (!toolCallId) return [];
		return [toolAwareness(
			toolCallId,
			timestamp,
			"Tool activity",
			raw.message.isError === true ? "failed" : "completed",
			sourceMessageId,
		)];
	}
	return [];
}

/** Project the shared ordered feed without leaking its internal payloads. */
export function projectConversationLiveEvent(event: RuntimeLiveEvent): ConversationLiveEvent {
	const base: ConversationLiveBase = {
		sequence: event.sequence,
		streamId: event.streamId,
		id: event.id,
		timestamp: event.timestamp,
	};
	if (event.kind === "reset") return { ...base, kind: "reset", reason: event.reason };
	if (event.kind === "awareness") {
		const message = projectConversationLine(event.line);
		const awareness = projectConversationAwarenessLine(event.line);
		const activity = awareness.length > 0 ? { awareness } : {};
		return message
			? { ...base, ...activity, kind: "message", message }
			: { ...base, ...activity, kind: "cursor" };
	}

	const projected = projectConversationRuntimeEvent(event.event, event.runId);
	const awareness = projectConversationRuntimeAwareness(event.event, event.timestamp);
	return {
		...base,
		...(awareness.length > 0 ? { awareness } : {}),
		...projected,
	} as ConversationLiveEvent;
}

function projectConversationRuntimeAwareness(
	event: RuntimeStreamEvent,
	timestamp: string,
): ConversationAwareness[] {
	if (event.type === "assistant_snapshot") {
		return projectToolContent(event.entry.content, event.entry.timestamp || timestamp, event.entry.id);
	}
	if (event.type === "toolResult") {
		return [toolAwareness(
			event.toolCallId,
			timestamp,
			"Tool activity",
			event.isError ? "failed" : "completed",
		)];
	}
	if (
		event.type === "toolCall"
		|| event.type === "toolcall_start"
		|| event.type === "toolcall_delta"
		|| event.type === "toolcall_end"
	) {
		const calls = [
			...(event.toolCalls ?? []),
			...(event.toolCall ? [event.toolCall] : []),
		];
		if (calls.length === 0 && event.id) {
			return [toolAwareness(event.id, timestamp, "Tool activity", "started")];
		}
		return calls.flatMap((call) => call.id
			? [toolAwareness(call.id, timestamp, call.label, "started")]
			: []);
	}
	return [];
}

function projectConversationRuntimeEvent(
	event: RuntimeStreamEvent,
	runId: string,
): ConversationLivePayload {
	if (event.type === "error") return { kind: "error", runId, message: event.message };
	if (event.type === "run_complete") return { kind: "completion", runId, completionId: runId };
	if (event.type === "assistant_snapshot") {
		const text = event.entry.content.flatMap((block): string[] => block.type === "text" ? [block.text] : []).join("");
		const isError = event.entry.stopReason === "error";
		const completionId = stringValue(event.entry.id) || runId;
		return {
			kind: "assistant",
			runId,
			completionId,
			text,
			isFinal: event.entry.isStreaming === false,
			isError,
			speechEligible: !isError,
		};
	}
	if (event.type === "text_delta") {
		return {
			kind: "assistant",
			runId,
			completionId: runId,
			text: event.text ?? event.delta,
			isFinal: false,
			isError: false,
			speechEligible: true,
		};
	}
	if (event.type === "text_patch") {
		return {
			kind: "assistant",
			runId,
			completionId: runId,
			text: event.text,
			isFinal: false,
			isError: false,
			speechEligible: true,
		};
	}
	if (event.type === "status") {
		return { kind: "state", runId, state: "thinking", ...(event.message ? { message: event.message } : {}) };
	}
	// Unsafe or operationally detailed runtime events still advance the cursor
	// while revealing no thinking, tool name, arguments, output, or result.
	return { kind: "cursor" };
}

/** Project the response stream for a mobile-originated turn. */
export function projectConversationTurnEvent(event: Record<string, unknown>): Record<string, unknown> {
	const type = stringValue(event.type);
	if (type === "delivery" || type === "heartbeat") return event;
	if (type === "error") return { type: "error", message: stringValue(event.message) || "Run failed" };
	if (type === "run_complete") return { type: "completion" };
	if (type === "text_delta") return { type: "assistant_delta", delta: stringValue(event.delta) };
	if (type === "text") return { type: "assistant_text", text: stringValue(event.text) };
	if (type === "text_patch") return { type: "assistant_text", text: stringValue(event.text) };
	if (type === "status") {
		return {
			type: "state",
			state: "thinking",
			...(stringValue(event.message) ? { message: stringValue(event.message) } : {}),
		};
	}
	if (type === "assistant_snapshot" && isRecord(event.entry)) {
		const content = Array.isArray(event.entry.content) ? event.entry.content : [];
		const text = content.flatMap((block): string[] =>
			isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
		return { type: "assistant_text", text };
	}
	return { type: "state", state: "thinking" };
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function projectToolContent(
	content: unknown[],
	timestamp: string,
	sourceMessageId?: string,
): ConversationAwareness[] {
	const projected = new Map<string, ConversationAwareness>();
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "toolCall") {
			const id = firstString(block.id, block.toolCallId, block.tool_call_id);
			if (!id) continue;
			projected.set(id, toolAwareness(
				id,
				timestamp,
				stringValue(block.label),
				"started",
				sourceMessageId,
			));
			continue;
		}
		if (block.type === "toolResult") {
			const id = firstString(block.toolCallId, block.tool_call_id);
			if (!id) continue;
			const existing = projected.get(id);
			projected.set(id, toolAwareness(
				id,
				timestamp,
				existing?.label,
				block.isError === true ? "failed" : "completed",
				sourceMessageId,
			));
		}
	}
	return [...projected.values()];
}

function toolAwareness(
	id: string,
	timestamp: string,
	label: unknown,
	state: ConversationToolState,
	sourceMessageId?: string,
): ConversationAwareness {
	return {
		id,
		timestamp,
		kind: "tool",
		label: safeToolLabel(label),
		state,
		...(sourceMessageId ? { sourceMessageId } : {}),
	};
}

function safeToolLabel(value: unknown): string {
	if (typeof value !== "string") return "Tool activity";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return "Tool activity";
	return [...normalized].slice(0, SAFE_TOOL_LABEL_LIMIT).join("");
}

function reconcileConversationAwareness(
	items: ConversationAwareness[],
): ConversationAwareness[] {
	const reconciled = new Map<string, ConversationAwareness>();
	for (const item of items) {
		const existing = reconciled.get(item.id);
		if (!existing) {
			reconciled.set(item.id, item);
			continue;
		}
		const state = item.state === "started" && existing.state !== "started"
			? existing.state
			: item.state;
		reconciled.set(item.id, {
			...item,
			timestamp: existing.timestamp || item.timestamp,
			label: existing.label !== "Tool activity" ? existing.label : item.label,
			state,
		});
	}
	return [...reconciled.values()];
}

function classifyAwareness(
	sourceEventType: string | undefined,
	channel: string | undefined,
): ConversationAwarenessKind | undefined {
	if (sourceEventType === "goal_continuation") return "goal_continuation";
	if (sourceEventType === "follow_up") return "follow_up";
	if (sourceEventType === "heartbeat") return "heartbeat";
	if (channel === "heartbeat" || channel === "heartbeat:heartbeat") return "heartbeat";
	return undefined;
}

function safeFollowUpText(value: string): string {
	const visible = value.replace(ATTENTION_PREFIX_RE, "").trim();
	const header = visible.match(FOLLOW_UP_HEADER_RE)?.[0];
	return header ? `${header}\nNatural follow-up check.` : "Natural follow-up check.";
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}
