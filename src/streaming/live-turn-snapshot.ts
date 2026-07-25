import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	RuntimeAssistantSnapshotContent,
	RuntimeAssistantSnapshotEntry,
	RuntimeToolOutputStream,
} from "../core/runtime-contract.js";

interface ToolOutputPatch {
	toolCallId: string;
	stream: RuntimeToolOutputStream;
	text: string;
	pid?: number;
	sequence?: number;
}

export class LiveAssistantSnapshot {
	private entry: RuntimeAssistantSnapshotEntry | null = null;
	private activeStart = 0;
	private activeLength = 0;

	beginAssistantMessage(message: AgentMessage): RuntimeAssistantSnapshotEntry | null {
		if (!isAssistantMessage(message)) return this.entry;
		this.ensureEntry(message);
		this.activeStart = this.entry?.content.length ?? 0;
		this.activeLength = 0;
		return this.replaceActiveMessage(message);
	}

	updateAssistantMessage(message: AgentMessage): RuntimeAssistantSnapshotEntry | null {
		if (!isAssistantMessage(message)) return this.entry;
		this.ensureEntry(message);
		return this.replaceActiveMessage(message);
	}

	endAssistantMessage(message: AgentMessage): RuntimeAssistantSnapshotEntry | null {
		const next = this.updateAssistantMessage(message);
		if (next) {
			this.activeStart = next.content.length;
			this.activeLength = 0;
			next.isStreaming = false;
		}
		return next;
	}

	upsertToolCall(toolCallId: string, name: string, args: Record<string, unknown>, label?: string): RuntimeAssistantSnapshotEntry | null {
		this.ensureEntry();
		if (!this.entry) return null;
		const content = [...this.entry.content];
		const existingIndex = content.findIndex((block) => block.type === "toolCall" && block.id === toolCallId);
		const patch: RuntimeAssistantSnapshotContent = {
			type: "toolCall",
			id: toolCallId,
			name,
			...(cleanLabel(label) ? { label: cleanLabel(label) } : {}),
			arguments: args,
		};
		if (existingIndex === -1) {
			content.push(patch);
		} else {
			const existing = content[existingIndex];
			content[existingIndex] = existing.type === "toolCall"
				? {
					...existing,
					...patch,
					arguments: { ...(existing.arguments || {}), ...args },
				}
				: patch;
		}
		this.entry = { ...this.entry, content, isStreaming: true };
		return this.entry;
	}

	appendToolOutput(output: ToolOutputPatch): RuntimeAssistantSnapshotEntry | null {
		if (!output.toolCallId) return this.entry;
		this.ensureEntry();
		if (!this.entry) return null;

		const content = [...this.entry.content];
		const existingIndex = content.findIndex((block) =>
			block.type === "toolOutput" && block.toolCallId === output.toolCallId
		);
		if (existingIndex === -1) {
			const insertAt = findToolInsertIndex(content, output.toolCallId);
			content.splice(insertAt, 0, {
				type: "toolOutput",
				toolCallId: output.toolCallId,
				stream: output.stream,
				text: output.text,
				pid: output.pid,
				sequence: output.sequence,
			});
		} else {
			const existing = content[existingIndex];
			if (existing.type === "toolOutput") {
				content[existingIndex] = {
					...existing,
					stream: output.stream || existing.stream,
					text: existing.text + output.text,
					pid: output.pid ?? existing.pid,
					sequence: output.sequence ?? existing.sequence,
				};
			}
		}
		this.entry = { ...this.entry, content, isStreaming: true };
		return this.entry;
	}

	upsertToolResult(toolCallId: string, result: string, isError?: boolean): RuntimeAssistantSnapshotEntry | null {
		if (!toolCallId) return this.entry;
		this.ensureEntry();
		if (!this.entry) return null;

		const content = [...this.entry.content];
		const existingIndex = content.findIndex((block) =>
			block.type === "toolResult" && block.toolCallId === toolCallId
		);
		const patch: RuntimeAssistantSnapshotContent = {
			type: "toolResult",
			toolCallId,
			result,
			isError,
		};
		if (existingIndex === -1) {
			const insertAt = findToolInsertIndex(content, toolCallId);
			content.splice(insertAt, 0, patch);
		} else {
			content[existingIndex] = patch;
		}
		this.entry = { ...this.entry, content, isStreaming: true };
		return this.entry;
	}

	current(isStreaming = true): RuntimeAssistantSnapshotEntry | null {
		if (!this.entry) return null;
		return { ...this.entry, content: [...this.entry.content], isStreaming };
	}

	reset(): void {
		this.entry = null;
		this.activeStart = 0;
		this.activeLength = 0;
	}

	private ensureEntry(message?: AgentMessage): void {
		if (this.entry) return;
		this.entry = {
			id: "live-assistant",
			type: "message",
			timestamp: messageTimestamp(message),
			role: "assistant",
			content: [],
			isStreaming: true,
		};
	}

	private replaceActiveMessage(message: AgentMessage): RuntimeAssistantSnapshotEntry | null {
		if (!isAssistantMessage(message) || !this.entry) return this.entry;
		const content = [...this.entry.content];
		const normalized = normalizeAssistantContent(message);
		content.splice(this.activeStart, this.activeLength, ...normalized);
		this.activeLength = normalized.length;
		this.entry = {
			...this.entry,
			timestamp: this.entry.timestamp || messageTimestamp(message),
			model: typeof message.model === "string" ? message.model : this.entry.model,
			stopReason: typeof message.stopReason === "string" ? message.stopReason : this.entry.stopReason,
			content,
			isStreaming: true,
		};
		return this.entry;
	}
}

function normalizeAssistantContent(message: AgentMessage): RuntimeAssistantSnapshotContent[] {
	if (!isAssistantMessage(message)) return [];
	const content = Array.isArray(message.content) ? message.content : [];
	return content.flatMap((block, contentIndex): RuntimeAssistantSnapshotContent[] => {
		if (!block || typeof block !== "object") return [];
		if (block.type === "text") {
			return [{
				type: "text",
				text: typeof block.text === "string" ? block.text : "",
				contentIndex,
			}];
		}
		if (block.type === "thinking") {
			return [{
				type: "thinking",
				thinking: typeof block.thinking === "string" ? block.thinking : "",
				thinkingSignature: typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined,
				contentIndex,
			}];
		}
		if (block.type === "toolCall") {
			const args = block.arguments && typeof block.arguments === "object"
				? block.arguments as Record<string, unknown>
				: {};
			return [{
				type: "toolCall",
				id: String(block.id || ""),
				name: String(block.name || "tool"),
				...(cleanLabel((block as { label?: unknown }).label) || cleanLabel(args.label)
					? { label: cleanLabel((block as { label?: unknown }).label) || cleanLabel(args.label) }
					: {}),
				arguments: args,
				contentIndex,
			}];
		}
		return [];
	});
}

function cleanLabel(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findToolInsertIndex(content: RuntimeAssistantSnapshotContent[], toolCallId: string): number {
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (block.type === "toolCall" && block.id === toolCallId) return i + 1;
		if (block.type === "toolOutput" && block.toolCallId === toolCallId) return i + 1;
		if (block.type === "toolResult" && block.toolCallId === toolCallId) return i + 1;
	}
	return content.length;
}

function isAssistantMessage(message: AgentMessage | undefined): message is AgentMessage & {
	role: "assistant";
	content: Array<Record<string, any>>;
	model?: string;
	stopReason?: string;
	timestamp?: number | string;
} {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

function messageTimestamp(message?: AgentMessage): string {
	const timestamp = (message as { timestamp?: unknown } | undefined)?.timestamp;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	if (typeof timestamp === "string" && timestamp.trim()) return timestamp;
	return new Date().toISOString();
}
