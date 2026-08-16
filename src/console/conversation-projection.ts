import type { RuntimeLiveEvent, RuntimeStreamEvent } from "../core/runtime-contract.js";

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
	id: string;
	timestamp: string;
	role: ConversationRole;
	text: string;
	channel?: string;
	userName?: string;
	completionId?: string;
	isError: boolean;
	speechEligible: boolean;
}

export interface ConversationBacklog {
	messages: ConversationMessage[];
	total: number;
	offset: number;
}

interface ConversationLiveBase {
	sequence: number;
	streamId: string;
	id: string;
	timestamp: string;
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
const USER_PREFIX_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/;

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
	if (role === "user") {
		text = text.replace(MODEL_CONTEXT_BLOCK_RE, "").trim();
		const match = text.match(USER_PREFIX_RE);
		if (match) {
			channel = match[2].trim() || undefined;
			userName = match[3].trim() || undefined;
			text = match[4];
		}
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
		...(role === "assistant" ? { completionId: id } : {}),
		isError,
		speechEligible: role === "assistant" && !isError,
	};
}

export function projectConversationBacklog(
	backlog: { lines: string[]; total: number; offset: number },
): ConversationBacklog {
	return {
		messages: backlog.lines.flatMap((line) => {
			const message = projectConversationLine(line);
			return message ? [message] : [];
		}),
		total: backlog.total,
		offset: backlog.offset,
	};
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
		return message ? { ...base, kind: "message", message } : { ...base, kind: "cursor" };
	}

	const projected = projectConversationRuntimeEvent(event.event, event.runId);
	return { ...base, ...projected } as ConversationLiveEvent;
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
		return {
			kind: "assistant",
			runId,
			completionId: runId,
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

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}
