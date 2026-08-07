import { appendFileSync, chmodSync, mkdirSync } from "fs";
import { join } from "path";

export interface ContextComposition {
	messageCount: number;
	summaryDepth: number;
	characters: {
		sessionContext: number;
		deliveryContext: number;
		userConversation: number;
		assistant: number;
		toolResults: number;
		compactionSummaries: number;
		other: number;
		total: number;
	};
	estimatedTokens: number;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (!part || typeof part !== "object") return "";
		const record = part as Record<string, unknown>;
		if (typeof record.text === "string") return record.text;
		if (typeof record.thinking === "string") return record.thinking;
		if (record.arguments) {
			try { return JSON.stringify(record.arguments); } catch { return ""; }
		}
		return "";
	}).join("\n");
}

function extractTaggedLength(text: string, names: string[]): number {
	let total = 0;
	for (const name of names) {
		const expression = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`, "g");
		for (const match of text.matchAll(expression)) total += match[0].length;
	}
	return total;
}

export function measureContextComposition(messages: unknown[]): ContextComposition {
	const characters = {
		sessionContext: 0,
		deliveryContext: 0,
		userConversation: 0,
		assistant: 0,
		toolResults: 0,
		compactionSummaries: 0,
		other: 0,
		total: 0,
	};
	let summaryDepth = 0;

	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message as Record<string, unknown>;
		const role = String(record.role ?? "");
		const text = role === "compactionSummary" || role === "branchSummary"
			? String(record.summary ?? "")
			: contentText(record.content);
		characters.total += text.length;

		if (role === "user") {
			const sessionChars = extractTaggedLength(text, ["session_context", "session_context_delta", "session_context_ref"]);
			const deliveryChars = extractTaggedLength(text, ["delivery_context"]);
			characters.sessionContext += sessionChars;
			characters.deliveryContext += deliveryChars;
			characters.userConversation += Math.max(0, text.length - sessionChars - deliveryChars);
		} else if (role === "assistant") {
			characters.assistant += text.length;
		} else if (role === "toolResult") {
			characters.toolResults += text.length;
		} else if (role === "compactionSummary" || role === "branchSummary") {
			characters.compactionSummaries += text.length;
			summaryDepth++;
		} else {
			characters.other += text.length;
		}
	}

	return {
		messageCount: messages.length,
		summaryDepth,
		characters,
		estimatedTokens: Math.ceil(characters.total / 4),
	};
}

function appendMetricFile(awarenessDir: string, filename: string, record: Record<string, unknown>): void {
	mkdirSync(awarenessDir, { recursive: true, mode: 0o700 });
	const path = join(awarenessDir, filename);
	appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
}

export function appendCompactionMetric(awarenessDir: string, record: Record<string, unknown>): void {
	appendMetricFile(awarenessDir, "compaction-metrics.jsonl", record);
}

export function appendContextMetric(awarenessDir: string, record: Record<string, unknown>): void {
	appendMetricFile(awarenessDir, "context-metrics.jsonl", record);
}
