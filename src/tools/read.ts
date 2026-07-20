import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { extname } from "path";
import type { Executor } from "../sandbox.js";
import { isValidImageBase64 } from "../image-content.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

/**
 * Map of file extensions to MIME types for common image formats
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

export const MAX_READ_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Check if a file is an image based on its extension
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	show: Type.Optional(Type.Boolean({ description: "Surface this safe label only when it is a meaningful progress milestone. Default false." })),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

interface ReadToolDetails {
	truncation?: TruncationResult;
}

export function createReadTool(executor: Executor): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments and must be no larger than ${formatSize(MAX_READ_IMAGE_BYTES)}; resize or compress larger images first. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const mimeType = isImageFile(path);

			if (mimeType) {
				const sizeResult = await executor.exec(`wc -c < ${shellEscape(path)}`, { signal });
				if (sizeResult.code !== 0) {
					throw new Error(sizeResult.stderr || `Failed to read file: ${path}`);
				}
				const imageBytes = Number.parseInt(sizeResult.stdout.trim(), 10);
				if (!Number.isSafeInteger(imageBytes) || imageBytes < 0) {
					throw new Error(`Could not determine image size: ${path}`);
				}
				if (imageBytes > MAX_READ_IMAGE_BYTES) {
					throw new Error(
						`Image is ${formatSize(imageBytes)}, which exceeds the ${formatSize(MAX_READ_IMAGE_BYTES)} read limit. ` +
						"Resize or compress it to a smaller copy before reading it.",
					);
				}

				// Read as image (binary) - use base64
				const result = await executor.exec(`base64 < ${shellEscape(path)}`, { signal });
				if (result.code !== 0) {
					throw new Error(result.stderr || `Failed to read file: ${path}`);
				}
				if (result.stdoutTruncated) {
					throw new Error(`Image encoding exceeded the executor output limit: ${path}`);
				}
				const base64 = result.stdout.replace(/\s/g, ""); // Remove whitespace from base64
				if (!isValidImageBase64(base64)) {
					throw new Error(`Image encoding produced invalid base64 data: ${path}`);
				}

				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: base64, mimeType },
					],
					details: undefined,
				};
			}

			// Get total line count first
			const countResult = await executor.exec(`wc -l < ${shellEscape(path)}`, { signal });
			if (countResult.code !== 0) {
				throw new Error(countResult.stderr || `Failed to read file: ${path}`);
			}
			const totalFileLines = Number.parseInt(countResult.stdout.trim(), 10) + 1; // wc -l counts newlines, not lines

			// Apply offset if specified (1-indexed)
			const startLine = offset ? Math.max(1, offset) : 1;
			const startLineDisplay = startLine;

			// Check if offset is out of bounds
			if (startLine > totalFileLines) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
			}

			// Read content with offset
			let cmd: string;
			if (startLine === 1) {
				cmd = `cat ${shellEscape(path)}`;
			} else {
				cmd = `tail -n +${startLine} ${shellEscape(path)}`;
			}

			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to read file: ${path}`);
			}

			let selectedContent = result.stdout;
			let userLimitedLines: number | undefined;

			// Apply user limit if specified
			if (limit !== undefined) {
				const lines = selectedContent.split("\n");
				const endLine = Math.min(limit, lines.length);
				selectedContent = lines.slice(0, endLine).join("\n");
				userLimitedLines = endLine;
			}

			// Apply truncation (respects both line and byte limits)
			const truncation = truncateHead(selectedContent);

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				// First line at offset exceeds 50KB - tell model to use bash
				const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				// Truncation occurred - build actionable notice
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined) {
				// User specified limit, check if there's more content
				const linesFromStart = startLine - 1 + userLimitedLines;
				if (linesFromStart < totalFileLines) {
					const remaining = totalFileLines - linesFromStart;
					const nextOffset = startLine + userLimitedLines;

					outputText = truncation.content;
					outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
				} else {
					outputText = truncation.content;
				}
			} else {
				// No truncation, no user limit exceeded
				outputText = truncation.content;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
