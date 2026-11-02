import type { RuntimeAssistantSnapshotEntry } from "../core/runtime-contract.js";

/**
 * Display-only record of a turn's interleaved text and tool calls.
 *
 * Runtimes that execute tools outside the agent loop (Claude CLI over MCP)
 * persist an assistant message that holds only text, so reloaded transcripts
 * lose their tool rows. This custom session entry restores them for clients.
 * It is never part of LLM context: custom entries are skipped when the
 * session context is rebuilt.
 */
export const TOOL_PRESENTATION_CUSTOM_TYPE = "troublemaker.tool-presentation";

const MAX_STRING_CHARS = 300;
const MAX_ARGUMENT_KEYS = 24;

export type ToolPresentationBlock =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; label?: string; arguments: Record<string, unknown> }
	| { type: "toolResult"; toolCallId: string; isError: boolean };

export interface ToolPresentationData {
	/** `timestamp` of the persisted assistant message this record decorates. */
	messageTimestamp: number;
	content: ToolPresentationBlock[];
}

export function buildToolPresentation(
	entry: RuntimeAssistantSnapshotEntry | null,
	messageTimestamp: number,
): ToolPresentationData | null {
	if (!entry || !Number.isFinite(messageTimestamp)) return null;
	const content: ToolPresentationBlock[] = [];
	for (const block of entry.content) {
		if (block.type === "text") {
			if (block.text) content.push({ type: "text", text: block.text });
		} else if (block.type === "toolCall") {
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				...(block.label ? { label: block.label } : {}),
				arguments: compactArguments(block.arguments),
			});
		} else if (block.type === "toolResult") {
			content.push({ type: "toolResult", toolCallId: block.toolCallId, isError: block.isError === true });
		}
	}
	if (!content.some((block) => block.type === "toolCall")) return null;
	return { messageTimestamp, content };
}

function compactArguments(args: Record<string, unknown> | undefined): Record<string, unknown> {
	const compact: Record<string, unknown> = {};
	if (!args || typeof args !== "object") return compact;
	for (const [key, value] of Object.entries(args).slice(0, MAX_ARGUMENT_KEYS)) {
		if (value === null || typeof value === "number" || typeof value === "boolean") compact[key] = value;
		else if (typeof value === "string") compact[key] = truncate(value);
		else if (value !== undefined) compact[key] = truncate(safeJson(value));
	}
	return compact;
}

function truncate(value: string): string {
	return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}
