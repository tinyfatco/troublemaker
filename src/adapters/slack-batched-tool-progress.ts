import {
	mergeToolExecutionDetails,
	type ConversationToolDetailContent,
	type ConversationToolExecutionDetails,
} from "../console/tool-detail-projection.js";
import type { ToolProgressUpdate } from "./types.js";

const MAX_TRACKED_TOOLS = 256;
const MAX_RETIRED_TOOL_IDS = 2_048;
const LIFECYCLE_OVERHEAD = 192;

export interface SlackBatchedToolProgressApi {
	surfaceBatchRoot(update: ToolProgressUpdate): Promise<string | undefined>;
	updateMessage(channel: string, ts: string, text: string): Promise<void>;
	postReply(channel: string, threadTs: string, text: string): Promise<string>;
	deleteMessage(channel: string, ts: string): Promise<void>;
}

export interface SlackBatchedToolProgressOptions {
	api: SlackBatchedToolProgressApi;
	channel: string;
	maxMessageLength: number;
	warn?: (message: string, error: unknown) => void;
}

interface ToolLifecycleState {
	id: string;
	label: string;
	batchRootTs: string;
	status: ToolProgressUpdate["status"];
	details?: ConversationToolExecutionDetails;
	replyTs?: string;
	replyText?: string;
}

/**
 * The existing working context owns compact rolling batch roots. This class
 * binds each surfaced tool to the root selected at start and reconciles one
 * bounded lifecycle reply under that root through completion.
 */
export class SlackBatchedToolProgress {
	private readonly tools = new Map<string, ToolLifecycleState>();
	private readonly retiredToolIds = new Set<string>();
	private readonly retiredReplyIds: string[] = [];
	private operation = Promise.resolve();

	constructor(private readonly options: SlackBatchedToolProgressOptions) {}

	async update(update: ToolProgressUpdate): Promise<void> {
		return this.serialize(async () => {
			if (this.retiredToolIds.has(update.id)) return;
			let state = this.tools.get(update.id);
			if (!state) {
				const batchRootTs = await this.options.api.surfaceBatchRoot(update);
				if (!batchRootTs) return;
				state = {
					id: update.id,
					label: update.label,
					batchRootTs,
					status: update.status,
					details: update.details,
				};
				this.tools.set(update.id, state);
			} else {
				state.label = update.label;
				state.status = update.status;
				state.details = mergeToolExecutionDetails(state.details, update.details);
			}

			const text = formatLifecycle(state, this.options.maxMessageLength);
			if (text !== state.replyText) {
				if (state.replyTs) {
					await this.options.api.updateMessage(this.options.channel, state.replyTs, text);
				} else {
					state.replyTs = await this.options.api.postReply(this.options.channel, state.batchRootTs, text);
				}
				state.replyText = text;
			}
			this.prune();
		});
	}

	async deleteAll(): Promise<void> {
		return this.serialize(async () => {
			for (const state of [...this.tools.values()].reverse()) {
				if (state.replyTs) await this.deleteOwned(state.replyTs);
			}
			for (const ts of [...this.retiredReplyIds].reverse()) await this.deleteOwned(ts);
			this.tools.clear();
			this.retiredToolIds.clear();
			this.retiredReplyIds.length = 0;
		});
	}

	private async deleteOwned(ts: string): Promise<void> {
		try {
			await this.options.api.deleteMessage(this.options.channel, ts);
		} catch (error) {
			this.options.warn?.("Failed to delete agent-owned Slack tool lifecycle reply", error);
		}
	}

	private prune(): void {
		while (this.tools.size > MAX_TRACKED_TOOLS) {
			const oldest = [...this.tools.values()].find((state) => state.status !== "in_progress");
			if (!oldest) return;
			this.tools.delete(oldest.id);
			this.retiredToolIds.add(oldest.id);
			while (this.retiredToolIds.size > MAX_RETIRED_TOOL_IDS) {
				const expired = this.retiredToolIds.values().next().value;
				if (typeof expired !== "string") break;
				this.retiredToolIds.delete(expired);
			}
			if (oldest.replyTs) this.retiredReplyIds.push(oldest.replyTs);
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const current = this.operation.then(operation);
		this.operation = current.then(() => undefined, () => undefined);
		return current;
	}
}

function formatLifecycle(state: ToolLifecycleState, maxMessageLength: number): string {
	const status = state.status === "error" ? "Failed" : state.status === "complete" ? "Complete" : "Running";
	const icon = state.status === "error" ? "✗" : state.status === "complete" ? "✓" : "→";
	const detailCount = Number(Boolean(state.details?.invocation?.text)) + Number(Boolean(state.details?.result?.text));
	const labelLimit = Math.min(512, Math.max(32, Math.floor(maxMessageLength * 0.2)));
	const detailBudget = Math.max(0, maxMessageLength - labelLimit - LIFECYCLE_OVERHEAD);
	const detailLimit = detailCount > 0 ? Math.max(64, Math.floor(detailBudget / detailCount)) : 0;
	const toolName = state.details?.toolName
		? boundInline(state.details.toolName.replace(/`/g, "'"), 128)
		: "";
	const lines = [
		`*${icon} ${boundInline(state.label, labelLimit)}*`,
		toolName ? `_${status}_ · \`${toolName}\`` : `_${status}_`,
	];
	if (state.details?.invocation?.text) {
		lines.push(formatDetail("Input", state.details.invocation, detailLimit));
	}
	if (state.details?.result?.text) {
		lines.push(formatDetail(state.status === "error" ? "Error" : "Output", state.details.result, detailLimit));
	}
	if (state.details?.durationMilliseconds !== undefined) {
		lines.push(`_${Math.round(state.details.durationMilliseconds)} ms_`);
	}
	const message = lines.join("\n\n");
	if (message.length <= maxMessageLength) return message;
	return `${icon} ${boundInline(state.label, Math.max(1, maxMessageLength - status.length - 6))} · ${status}`;
}

function formatDetail(title: string, detail: ConversationToolDetailContent, limit: number): string {
	const safe = detail.text.replace(/```/g, "` ` `");
	const locallyTruncated = safe.length > limit;
	const bounded = locallyTruncated
		? `${safe.slice(0, Math.max(0, limit - 24))}\n… detail truncated …`
		: safe;
	const suffix = detail.isTruncated || locallyTruncated
		? "\n_Truncated by the safe display boundary._"
		: "";
	return `*${title}*\n\`\`\`\n${bounded}\n\`\`\`${suffix}`;
}

function boundInline(value: string, maxLength: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length <= maxLength
		? oneLine
		: `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}
