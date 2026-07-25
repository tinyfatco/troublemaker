import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bashToolSchema, DEFAULT_BASH_TIMEOUT_SECONDS, type BashToolInput } from "../core/tool-definitions.js";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";
import { emitToolOutput } from "./tool-output-stream.js";

/**
 * Generate a unique temp file path for bash output
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `mom-bash-${id}.log`);
}

interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export function createBashTool(executor: Executor): AgentTool<typeof bashToolSchema> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Default timeout: ${DEFAULT_BASH_TIMEOUT_SECONDS}s. Increase for intentionally long-running commands.`,
		parameters: bashToolSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: BashToolInput,
			signal?: AbortSignal,
		) => {
			// Track output for potential temp file writing
			let tempFilePath: string | undefined;
			let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
			let pid: number | undefined;
			let streamedBytes = 0;
			let streamingTruncated = false;

			const emitLiveOutput = (stream: "stdout" | "stderr", text: string) => {
				if (!text || streamingTruncated) return;

				const remainingBytes = DEFAULT_MAX_BYTES - streamedBytes;
				const bytes = Buffer.from(text, "utf-8");
				if (bytes.length <= remainingBytes) {
					streamedBytes += bytes.length;
					emitToolOutput({ toolCallId: _toolCallId, stream, text, pid });
					return;
				}

				if (remainingBytes > 0) {
					const partial = bytes.subarray(0, remainingBytes).toString("utf-8");
					streamedBytes += Buffer.byteLength(partial, "utf-8");
					emitToolOutput({ toolCallId: _toolCallId, stream, text: partial, pid });
				}

				streamingTruncated = true;
				emitToolOutput({
					toolCallId: _toolCallId,
					stream: "system",
					text: `\n[Live output truncated at ${formatSize(DEFAULT_MAX_BYTES)}; final result will include the tail.]\n`,
					pid,
				});
			};

			const result = await executor.exec(command, {
				timeout: timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS,
				signal,
				onStart: (info) => {
					pid = info.pid;
					emitToolOutput({ toolCallId: _toolCallId, stream: "system", text: "", pid });
				},
				onOutput: (chunk) => emitLiveOutput(chunk.stream, chunk.text),
			});
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			const totalBytes = Buffer.byteLength(output, "utf-8");

			// Write to temp file if output exceeds limit
			if (totalBytes > DEFAULT_MAX_BYTES) {
				tempFilePath = getTempFilePath();
				tempFileStream = createWriteStream(tempFilePath);
				tempFileStream.write(output);
				tempFileStream.end();
			}

			// Apply tail truncation
			const truncation = truncateTail(output);
			let outputText = truncation.content || "(no output)";

			// Build details with truncation info
			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: tempFilePath,
				};

				// Build actionable notice
				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;

				if (truncation.lastLinePartial) {
					// Edge case: last line alone > 50KB
					const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
				}
			}

			if (result.code !== 0) {
				throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
