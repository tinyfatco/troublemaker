import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash, randomUUID } from "crypto";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join, relative } from "path";

export const DEFAULT_INLINE_TOOL_RESULT_CHARS = 24_000;
const wrappedTools = new WeakSet<object>();

export interface BoundedToolResult {
	result: unknown;
	artifact?: {
		path: string;
		sha256: string;
		bytes: number;
	};
}

function containsModelImageContent(result: unknown): boolean {
	if (!result || typeof result !== "object" || Array.isArray(result)) return false;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (!block || typeof block !== "object" || Array.isArray(block)) return false;
		const candidate = block as { type?: unknown; data?: unknown; mimeType?: unknown };
		return candidate.type === "image"
			&& typeof candidate.data === "string"
			&& typeof candidate.mimeType === "string";
	});
}

function serializeResult(result: unknown): { text: string; structured: boolean } {
	if (typeof result === "string") return { text: result, structured: false };
	try {
		return { text: JSON.stringify(result, null, 2), structured: true };
	} catch {
		return { text: String(result), structured: false };
	}
}

function boundedExcerpt(text: string, limit: number): string {
	const markerBudget = 320;
	const contentBudget = Math.max(512, limit - markerBudget);
	const head = Math.ceil(contentBudget * 0.7);
	const tail = contentBudget - head;
	return `${text.slice(0, head)}\n\n… ${text.length - contentBudget} characters omitted from inline context …\n\n${text.slice(-tail)}`;
}

export function boundToolResultToArtifact(options: {
	workspaceDir: string;
	toolName: string;
	toolCallId: string;
	result: unknown;
	maxInlineChars?: number;
}): BoundedToolResult {
	const maxInlineChars = Math.max(2_000, options.maxInlineChars ?? DEFAULT_INLINE_TOOL_RESULT_CHARS);
	// Image data is model input, not textual context. Replacing it with an artifact
	// notice would silently remove vision capability from tools such as read.
	if (containsModelImageContent(options.result)) return { result: options.result };
	const serialized = serializeResult(options.result);
	if (serialized.text.length <= maxInlineChars) return { result: options.result };

	const bytes = Buffer.byteLength(serialized.text);
	const sha256 = createHash("sha256").update(serialized.text).digest("hex");
	const day = new Date().toISOString().slice(0, 10);
	const artifactDir = join(options.workspaceDir, "awareness", "artifacts", "tool-results", day);
	mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
	const callDigest = createHash("sha256").update(options.toolCallId).digest("hex").slice(0, 12);
	const filename = `${Date.now()}-${callDigest}-${randomUUID().slice(0, 8)}.${serialized.structured ? "json" : "txt"}`;
	const artifactPath = join(artifactDir, filename);
	writeFileSync(artifactPath, serialized.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
	chmodSync(artifactPath, 0o600);
	const relativePath = relative(options.workspaceDir, artifactPath);
	const notice = [
		`[Tool output bounded: ${serialized.text.length} characters / ${bytes} bytes.]`,
		`Full output: ${relativePath}`,
		`SHA-256: ${sha256}`,
		"Use the read tool with offset/limit if more detail is needed.",
		"",
		boundedExcerpt(serialized.text, maxInlineChars),
	].join("\n");

	if (typeof options.result === "string") {
		return { result: notice, artifact: { path: relativePath, sha256, bytes } };
	}
	if (options.result && typeof options.result === "object" && !Array.isArray(options.result)) {
		return {
			result: {
				...(options.result as Record<string, unknown>),
				content: [{ type: "text", text: notice }],
			},
			artifact: { path: relativePath, sha256, bytes },
		};
	}
	return { result: notice, artifact: { path: relativePath, sha256, bytes } };
}

export function boundToolResults<T extends AgentTool<any>>(
	tool: T,
	workspaceDir: string,
	maxInlineChars = DEFAULT_INLINE_TOOL_RESULT_CHARS,
): T {
	if (wrappedTools.has(tool as object)) return tool;
	const originalExecute = tool.execute;
	tool.execute = (async (...args: unknown[]) => {
		const result = await (originalExecute as (...executeArgs: unknown[]) => unknown).apply(tool, args);
		return boundToolResultToArtifact({
			workspaceDir,
			toolName: tool.name,
			toolCallId: typeof args[0] === "string" ? args[0] : randomUUID(),
			result,
			maxInlineChars,
		}).result;
	}) as typeof tool.execute;
	wrappedTools.add(tool as object);
	return tool;
}

export function boundAllToolResults<T extends AgentTool<any>>(
	tools: T[],
	workspaceDir: string,
	maxInlineChars = DEFAULT_INLINE_TOOL_RESULT_CHARS,
): T[] {
	return tools.map((tool) => boundToolResults(tool, workspaceDir, maxInlineChars));
}
