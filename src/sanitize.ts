/**
 * Sanitize message arrays before sending them to provider APIs.
 *
 * Fixes corrupted conversation context where tool result messages
 * exist without a matching tool call in the preceding assistant message.
 * This can happen when a session is interrupted mid-tool-call.
 */

import * as log from "./log.js";
import { isValidImageBase64 } from "./image-content.js";

interface ContentBlock {
	type: string;
	id?: string;
	toolCallId?: string;
	tool_use_id?: string;
	[key: string]: unknown;
}

interface Message {
	role: string;
	content?: string | ContentBlock[];
	[key: string]: unknown;
}

/**
 * Validate and fix message content and sequencing for provider compatibility.
 *
 * Rules enforced:
 * - Every toolResult message must have a preceding assistant message
 *   containing a tool call block with a matching ID
 * - Orphaned toolResult messages are stripped with a warning
 * - Malformed image blocks are replaced with recovery text
 *
 * @returns Sanitized copy of the messages array
 */
export function sanitizeMessages(messages: Message[]): Message[] {
	const result: Message[] = [];
	let stripped = 0;
	let invalidImages = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		// Check toolResult messages for matching tool calls
		if (msg.role === "toolResult" || (msg.role === "user" && hasToolResults(msg))) {
			const toolResultIds = getToolResultIds(msg);

			if (toolResultIds.length > 0) {
				// Find the preceding assistant message
				const prevAssistant = findPrecedingAssistant(result);
				const toolUseIds = prevAssistant ? getToolUseIds(prevAssistant) : new Set<string>();

				// Check if all tool result IDs have matching tool calls
				const allMatched = toolResultIds.every((id) => toolUseIds.has(id));

				if (!allMatched) {
					const orphanedIds = toolResultIds.filter((id) => !toolUseIds.has(id));
					log.logWarning(
						`[sanitize] Stripping message with orphaned tool_result IDs: ${orphanedIds.join(", ")}`,
					);
					stripped++;
					continue; // Skip this message
				}
			}
		}

		if (Array.isArray(msg.content)) {
			const sanitized = sanitizeContentBlocks(msg.content);
			invalidImages += sanitized.invalidImages;
			result.push(sanitized.invalidImages > 0 ? { ...msg, content: sanitized.content } : msg);
		} else {
			result.push(msg);
		}
	}

	if (stripped > 0) {
		log.logWarning(`[sanitize] Stripped ${stripped} message(s) with orphaned tool_results`);
	}
	if (invalidImages > 0) {
		log.logWarning(`[sanitize] Replaced ${invalidImages} invalid image block(s)`);
	}

	return result;
}

function sanitizeContentBlocks(content: ContentBlock[]): { content: ContentBlock[]; invalidImages: number } {
	let invalidImages = 0;
	let changed = false;
	const sanitized = content.map((block) => {
		if (block.type === "image" && !isValidImageBase64(block.data)) {
			invalidImages++;
			changed = true;
			return {
				type: "text",
				text: "[Invalid image attachment omitted during context recovery]",
			};
		}

		if (Array.isArray(block.content)) {
			const nested = sanitizeContentBlocks(block.content as ContentBlock[]);
			if (nested.invalidImages > 0) {
				invalidImages += nested.invalidImages;
				changed = true;
				return { ...block, content: nested.content };
			}
		}

		return block;
	});

	return { content: changed ? sanitized : content, invalidImages };
}

function hasToolResults(msg: Message): boolean {
	if (!Array.isArray(msg.content)) return false;
	return msg.content.some((block) => block.type === "tool_result" || block.type === "toolResult");
}

function getToolResultIds(msg: Message): string[] {
	// Handle toolResult role (pi-ai format)
	if (msg.role === "toolResult") {
		const id = (msg as Record<string, unknown>).toolCallId as string | undefined;
		return id ? [id] : [];
	}

	// Handle user messages with tool_result content blocks (Anthropic format)
	if (!Array.isArray(msg.content)) return [];
	return msg.content
		.map((block) => {
			if (block.type === "tool_result" && block.tool_use_id) return block.tool_use_id as string;
			if (block.type === "toolResult" && block.toolCallId) return block.toolCallId as string;
			return undefined;
		})
		.filter((id): id is string => Boolean(id));
}

function findPrecedingAssistant(messages: Message[]): Message | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i];
	}
	return null;
}

function getToolUseIds(msg: Message): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(msg.content)) return ids;
	for (const block of msg.content) {
		if ((block.type === "tool_use" || block.type === "toolCall") && block.id) {
			ids.add(block.id);
		}
	}
	return ids;
}
