import type { RuntimeLiveEvent, RuntimeStreamEvent } from "../core/runtime-contract.js";
import { readVerifiedSenderIdentity } from "../sender-identity.js";
import {
	mergeToolExecutionDetails,
	projectToolInvocationDetails,
	projectToolResultDetails,
	type ConversationToolExecutionDetails,
} from "./tool-detail-projection.js";

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
	userId?: string;
	displayName?: string;
	completionId?: string;
	deliveryId?: string;
	awarenessKind?: ConversationAwarenessKind;
	isError: boolean;
	speechEligible: boolean;
}

/**
 * A deliberately narrow activity projection for native conversation clients.
 * Stable identity, a bounded human-readable action, lifecycle, and an optional
 * display-only detail projection are the entire boundary. Raw tool payloads,
 * credentials, hidden envelopes, and runtime topology never enter this shape.
 */
export interface ConversationAwareness {
	id: string;
	timestamp: string;
	kind: "tool";
	label: string;
	state: ConversationToolState;
	sourceMessageId?: string;
	details?: ConversationToolExecutionDetails;
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
	| {
		kind: "assistant";
		runId: string;
		completionId: string;
		revision?: number;
		text: string;
		isFinal: boolean;
		outcome?: "completed" | "cancelled" | "failed";
		durableMessageIds?: string[];
		isError: boolean;
		speechEligible: boolean;
	}
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
	const sender = role === "user" ? readVerifiedSenderIdentity(raw.message.senderIdentity) : undefined;
	const verifiedSender = sender?.userName === userName ? sender : undefined;
	return {
		id,
		timestamp: stringValue(raw.timestamp),
		role,
		text,
		...(channel ? { channel } : {}),
		...(userName ? { userName } : {}),
		...(verifiedSender ? { userId: verifiedSender.userId, displayName: verifiedSender.displayName } : {}),
		...(deliveryId ? { deliveryId } : {}),
		...(awarenessKind ? { awarenessKind } : {}),
		...(role === "assistant" ? { completionId: id } : {}),
		isError,
		speechEligible: role === "assistant" && !isError,
	};
}

export function projectConversationBacklog(
	backlog: { lines: string[]; total: number; offset: number },
	contextId?: string,
): ConversationBacklog {
	const messages: ConversationMessage[] = [];
	const awareness: ConversationAwareness[] = [];
	let includesCurrentContext = contextId === undefined;
	for (const line of backlog.lines) {
		const message = projectConversationLine(line);
		if (message?.role === "user" && contextId !== undefined) {
			// Awareness history is serial by canonical turn. A user input starts
			// one context span; its following assistant/tool records remain in
			// that span until the next user input chooses another exact context.
			includesCurrentContext = message.channel === contextId;
		}
		if (!includesCurrentContext) continue;
		if (message) messages.push(message);
		awareness.push(...projectConversationAwarenessLine(line));
	}
	const reconciledAwareness = reconcileConversationAwareness(awareness);
	return {
		messages,
		awareness: reconciledAwareness,
		total: contextId === undefined ? backlog.total : messages.length + reconciledAwareness.length,
		offset: contextId === undefined ? backlog.offset : 0,
	};
}

/** Project durable tool lifecycle plus bounded display-safe detail. */
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
			toolDisplayLabel({
				name: firstString(raw.message.toolName, raw.message.tool_name),
			}),
			raw.message.isError === true ? "failed" : "completed",
			sourceMessageId,
			projectToolResultDetails(raw.message),
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
			toolDisplayLabel({}),
			event.isError ? "failed" : "completed",
			undefined,
			projectToolResultDetails(event as unknown as Record<string, unknown>),
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
			return [toolAwareness(
				event.id,
				timestamp,
				toolDisplayLabel(event),
				"started",
				undefined,
				projectToolInvocationDetails(event as unknown as Record<string, unknown>),
			)];
		}
		return calls.flatMap((call) => call.id
			? [toolAwareness(
				call.id,
				timestamp,
				toolDisplayLabel(call),
				"started",
				undefined,
				projectToolInvocationDetails(call as unknown as Record<string, unknown>),
			)]
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
	if (event.type === "assistant_text") {
		// The run envelope is the transport authority. A conflicting nested
		// identity is ambiguous and therefore advances only the cursor.
		if (event.completionId !== runId) return { kind: "cursor" };
		return {
			kind: "assistant",
			runId,
			completionId: event.completionId,
			revision: event.revision,
			text: event.text,
			isFinal: event.isFinal,
			...(event.outcome ? { outcome: event.outcome } : {}),
			...(event.durableMessageIds ? { durableMessageIds: [...event.durableMessageIds] } : {}),
			isError: event.outcome === "failed",
			speechEligible: event.speechEligible,
		};
	}
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
	// Operational runtime events still advance only the prose cursor. Any tool
	// presentation belongs to the separately sanitized awareness sibling.
	return { kind: "cursor" };
}

/** Project the response stream for a mobile-originated turn. */
export function projectConversationTurnEvent(event: Record<string, unknown>): Record<string, unknown> {
	const type = stringValue(event.type);
	if (type === "delivery" || type === "heartbeat") return event;
	if (type === "error") return { type: "error", message: stringValue(event.message) || "Run failed" };
	if (type === "run_complete") return { type: "completion" };
	if (type === "assistant_text" && typeof event.completionId === "string") {
		const completionId = stringValue(event.completionId);
		const revision = finiteNonnegativeInteger(event.revision);
		const text = stringValue(event.text);
		const isFinal = event.isFinal === true;
		const outcome = event.outcome === "completed" || event.outcome === "cancelled" || event.outcome === "failed"
			? event.outcome
			: undefined;
		const durableMessageIds = Array.isArray(event.durableMessageIds)
			? event.durableMessageIds.flatMap((value): string[] => {
				const id = stringValue(value);
				return id ? [id] : [];
			})
			: [];
		if (!completionId || revision === undefined || typeof event.isFinal !== "boolean") {
			return { type: "state", state: "thinking" };
		}
		return {
			type: "assistant_text",
			completionId,
			revision,
			text,
			isFinal,
			...(outcome ? { outcome } : {}),
			...(durableMessageIds.length > 0 ? { durableMessageIds: [...new Set(durableMessageIds)] } : {}),
			speechEligible: event.speechEligible === true,
		};
	}
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
			const existing = projected.get(id);
			projected.set(id, toolAwareness(
				id,
				timestamp,
				toolDisplayLabel(block),
				"started",
				sourceMessageId,
				mergeToolExecutionDetails(existing?.details, projectToolInvocationDetails(block)),
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
				existing?.label ?? toolDisplayLabel({
					name: firstString(block.toolName, block.tool_name),
				}),
				block.isError === true ? "failed" : "completed",
				sourceMessageId,
				mergeToolExecutionDetails(
					existing?.details,
					projectToolResultDetails(block, existing?.details?.toolName),
				),
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
	details?: ConversationToolExecutionDetails,
): ConversationAwareness {
	return {
		id,
		timestamp,
		kind: "tool",
		label: safeToolLabel(label),
		state,
		...(sourceMessageId ? { sourceMessageId } : {}),
		...(details ? { details } : {}),
	};
}

function safeToolLabel(value: unknown): string {
	if (typeof value !== "string") return "Tool";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return "Tool";
	return [...normalized].slice(0, SAFE_TOOL_LABEL_LIMIT).join("");
}

/**
 * Match the native Mac projection without exporting the raw tool contract.
 * Only an explicitly display-safe label is considered from arguments; every
 * other argument is ignored. Namespaces are removed before the fallback tool
 * name is humanized and bounded.
 */
function toolDisplayLabel(tool: {
	label?: unknown;
	arguments?: unknown;
	name?: unknown;
}): string {
	const argumentsValue = isRecord(tool.arguments) ? tool.arguments : undefined;
	const explicit = optionalSafeToolLabel(tool.label)
		?? optionalSafeToolLabel(argumentsValue?.label);
	if (explicit) return explicit;

	const rawName = typeof tool.name === "string" ? tool.name.trim() : "";
	const leaf = rawName.split("__").at(-1) ?? "";
	const words = leaf
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!words) return "Tool";
	const humanized = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
	return safeToolLabel(humanized);
}

function optionalSafeToolLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return [...normalized].slice(0, SAFE_TOOL_LABEL_LIMIT).join("");
}

function isGenericToolLabel(value: string): boolean {
	return value === "Tool" || value === "Tool activity";
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
		const details = mergeToolExecutionDetails(existing.details, item.details);
		reconciled.set(item.id, {
			...item,
			timestamp: existing.timestamp || item.timestamp,
			label: !isGenericToolLabel(existing.label) ? existing.label : item.label,
			state,
			...(details ? { details } : {}),
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

function finiteNonnegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}
