/**
 * Assemble the user turn sent to the model for one inbound message, and
 * format runtime errors for users.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "fs";
import type { MomContext } from "../adapters/types.js";
import { formatDeliveryContext } from "../delivery-context.js";
import { resolveAckFastPath } from "../gpt-steering.js";
import * as log from "../log.js";
import { getImageMimeType } from "./event-format.js";

/** Local wall-clock timestamp with UTC offset, e.g. `2026-01-02 03:04:05+00:00`. */
export function formatPromptTimestamp(now: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	const offset = -now.getTimezoneOffset();
	const offsetSign = offset >= 0 ? "+" : "-";
	const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
	const offsetMins = pad(Math.abs(offset) % 60);
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
}

/**
 * Build the user message text (routing preamble, delivery context, tagged
 * text, non-image attachment paths, ack fast path) and inline image attachments.
 */
export function buildUserPrompt(
	ctx: MomContext,
	sessionPreamble: string,
	workspacePath: string,
	currentModel: Parameters<typeof resolveAckFastPath>[1],
): { finalUserMessage: string; imageAttachments: ImageContent[] } {
	// Build user message with timestamp, channel tag, and username
	const timestamp = formatPromptTimestamp(new Date());

	// Always tag messages with source channel
	const channelLabel = ctx.channelName || ctx.message.channel;
	const deliveryContext = formatDeliveryContext(ctx.message);
	const userMessage = `${sessionPreamble}${deliveryContext ? `\n\n${deliveryContext}` : ""}\n\n[${timestamp}] [${channelLabel}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

	const imageAttachments: ImageContent[] = [];
	const nonImagePaths: string[] = [];

	for (const a of ctx.message.attachments || []) {
		const fullPath = `${workspacePath}/${a.local}`;
		const mimeType = getImageMimeType(a.local);

		if (mimeType && existsSync(fullPath)) {
			try {
				imageAttachments.push({
					type: "image",
					mimeType,
					data: readFileSync(fullPath).toString("base64"),
				});
			} catch {
				nonImagePaths.push(fullPath);
			}
		} else {
			nonImagePaths.push(fullPath);
		}
	}

	let finalUserMessage = userMessage;
	if (nonImagePaths.length > 0) {
		finalUserMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
	}

	// GPT-5 ack fast path: short approvals get "skip recap, act now" injection
	const ackInstruction = resolveAckFastPath(ctx.message.text, currentModel);
	if (ackInstruction) {
		finalUserMessage += `\n\n${ackInstruction}`;
		log.logInfo(`[gpt-steering] Ack fast path injected for "${ctx.message.text.substring(0, 40)}"`);
	}
	return { finalUserMessage, imageAttachments };
}

export function formatUserVisibleError(message: string): string {
	const normalized = message.replace(/\s+/g, " ").trim();
	const redacted = normalized
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
		.replace(/\b(?:sk|sess|ghp|gho|github_pat)_[A-Za-z0-9._~+/=-]{12,}\b/g, "[redacted-token]");
	return redacted.length > 1200 ? `${redacted.substring(0, 1200)}...` : redacted;
}
