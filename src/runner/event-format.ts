/**
 * Pure helpers for presenting agent stream events: tool labels/args/results,
 * image attachment detection, and private-checkpoint message sanitizing.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

export function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

export function cleanToolCallLabel(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function hasContent(message: AgentMessage): message is AgentMessage & { content: Array<Record<string, unknown>> } {
	return "content" in message && Array.isArray(message.content);
}

export function sanitizeStreamingMessage(message: AgentMessage, _terminal: boolean): AgentMessage {
	if (message.role !== "assistant" || !hasContent(message)) return message;
	// A pressure-triggered checkpoint is private harness work, not an assistant
	// response. Hide the entire generated prose/reasoning segment, including any
	// preamble emitted before the private delimiter. The semantic transition row
	// owns presentation until the fresh-context continuation begins.
	return {
		...message,
		content: message.content.flatMap((part) => {
			if (part.type === "text" && typeof part.text === "string") return [{ ...part, text: "" }];
			if (part.type === "thinking") return [];
			if (part.type === "toolCall" && part.name === "handoff_context") return [];
			return [part];
		}),
	} as AgentMessage;
}

export function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

export function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

export function formatToolArgs(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}
