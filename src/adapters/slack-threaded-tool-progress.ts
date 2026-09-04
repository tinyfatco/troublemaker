import type { ToolStreamingMode } from "../context.js";
import {
	mergeToolExecutionDetails,
	type ConversationToolDetailContent,
	type ConversationToolExecutionDetails,
} from "../console/tool-detail-projection.js";
import type { ToolProgressUpdate } from "./types.js";

const MAX_TRACKED_TOOLS = 256;
const MAX_RETIRED_TOOL_IDS = 2_048;
const DETAIL_OVERHEAD = 160;

export interface SlackThreadedToolProgressApi {
	postRoot(channel: string, text: string): Promise<string>;
	updateMessage(channel: string, ts: string, text: string): Promise<void>;
	postReply(channel: string, threadTs: string, text: string): Promise<string>;
	deleteMessage(channel: string, ts: string): Promise<void>;
}

export interface SlackThreadedToolProgressOptions {
	api: SlackThreadedToolProgressApi;
	channel: string;
	mode: ToolStreamingMode;
	verbose: boolean;
	maxMessageLength: number;
	warn?: (message: string, error: unknown) => void;
}

interface ToolThreadState {
	id: string;
	rootTs: string;
	rootText: string;
	status: ToolProgressUpdate["status"];
	details?: ConversationToolExecutionDetails;
	invocationReplyTs?: string;
	invocationText?: string;
	resultReplyTs?: string;
	resultText?: string;
}

/**
 * Fixed Slack working output uses one agent-owned root per visible tool. Safe
 * invocation and result projections reconcile only inside that tool's thread;
 * unrelated tools can never share a catch-all reply locus.
 */
export class SlackThreadedToolProgress {
	private readonly tools = new Map<string, ToolThreadState>();
	private readonly retiredToolIds = new Set<string>();
	private readonly retiredMessageIds: string[] = [];
	private operation = Promise.resolve();

	constructor(private readonly options: SlackThreadedToolProgressOptions) {}

	async update(update: ToolProgressUpdate): Promise<void> {
		return this.serialize(async () => {
			if (this.retiredToolIds.has(update.id)) return;
			let state = this.tools.get(update.id);
			if (!state) {
				if (!this.shouldSurface(update.show === true)) return;
				const rootText = rootSummary(update, this.options.maxMessageLength);
				const rootTs = await this.options.api.postRoot(this.options.channel, rootText);
				state = { id: update.id, rootTs, rootText, status: update.status };
				this.tools.set(update.id, state);
			} else {
				const rootText = rootSummary(update, this.options.maxMessageLength);
				if (rootText !== state.rootText) {
					await this.options.api.updateMessage(this.options.channel, state.rootTs, rootText);
					state.rootText = rootText;
				}
				state.status = update.status;
			}

			state.details = mergeToolExecutionDetails(state.details, update.details);
			await this.syncDetail(state, "invocation", state.details?.invocation);
			await this.syncDetail(state, "result", state.details?.result);
			this.prune();
		});
	}

	async deleteAll(): Promise<void> {
		return this.serialize(async () => {
			const states = [...this.tools.values()].reverse();
			for (const state of states) {
				for (const ts of [state.resultReplyTs, state.invocationReplyTs, state.rootTs]) {
					if (!ts) continue;
					await this.deleteOwned(ts);
				}
			}
			for (const ts of [...this.retiredMessageIds].reverse()) {
				await this.deleteOwned(ts);
			}
			this.tools.clear();
			this.retiredToolIds.clear();
			this.retiredMessageIds.length = 0;
		});
	}

	private async deleteOwned(ts: string): Promise<void> {
		try {
			await this.options.api.deleteMessage(this.options.channel, ts);
		} catch (error) {
			this.options.warn?.("Failed to delete agent-owned Slack tool thread message", error);
		}
	}

	private shouldSurface(show: boolean): boolean {
		if (this.options.verbose) return true;
		if (this.options.mode === "all") return true;
		return this.options.mode === "important" && show;
	}

	private async syncDetail(
		state: ToolThreadState,
		kind: "invocation" | "result",
		detail: ConversationToolDetailContent | undefined,
	): Promise<void> {
		if (!detail?.text) return;
		const text = formatDetail(kind, detail, this.options.maxMessageLength);
		const previousText = kind === "invocation" ? state.invocationText : state.resultText;
		if (text === previousText) return;
		const replyTs = kind === "invocation" ? state.invocationReplyTs : state.resultReplyTs;
		if (replyTs) {
			await this.options.api.updateMessage(this.options.channel, replyTs, text);
		} else {
			const created = await this.options.api.postReply(this.options.channel, state.rootTs, text);
			if (kind === "invocation") state.invocationReplyTs = created;
			else state.resultReplyTs = created;
		}
		if (kind === "invocation") state.invocationText = text;
		else state.resultText = text;
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
			this.retiredMessageIds.push(
				oldest.rootTs,
				...(oldest.invocationReplyTs ? [oldest.invocationReplyTs] : []),
				...(oldest.resultReplyTs ? [oldest.resultReplyTs] : []),
			);
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const current = this.operation.then(operation);
		this.operation = current.then(() => undefined, () => undefined);
		return current;
	}
}

function rootSummary(update: ToolProgressUpdate, maxMessageLength: number): string {
	const icon = update.status === "error" ? "✗" : update.status === "complete" ? "✓" : "→";
	const limit = Math.max(1, maxMessageLength - 6);
	const label = update.label.length <= limit
		? update.label
		: `${update.label.slice(0, Math.max(0, limit - 1))}…`;
	return `_${icon} ${label}_`;
}

function formatDetail(
	kind: "invocation" | "result",
	detail: ConversationToolDetailContent,
	maxMessageLength: number,
): string {
	const heading = kind === "invocation" ? "Invocation" : "Result";
	const limit = Math.max(256, maxMessageLength - DETAIL_OVERHEAD);
	const safe = detail.text.replace(/```/g, "` ` `");
	const bounded = safe.length <= limit
		? safe
		: `${safe.slice(0, Math.max(0, limit - 32))}\n… detail truncated …`;
	return `*${heading}*\n\`\`\`\n${bounded}\n\`\`\`${detail.isTruncated ? "\n_Truncated by the safe detail projector._" : ""}`;
}
