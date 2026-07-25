import type { ToolProgressUpdate } from "./types.js";
import type { ToolStreamingMode } from "../context.js";

interface TaskUpdateChunk {
	type: "task_update";
	id: string;
	title: string;
	status: "in_progress" | "complete" | "error";
}

interface NativeStreamResponse {
	ts?: string;
}

export interface SlackNativeProgressApi {
	startStream(args: {
		channel: string;
		thread_ts: string;
		chunks: TaskUpdateChunk[];
		task_display_mode: "timeline";
		recipient_team_id?: string;
		recipient_user_id?: string;
	}): Promise<NativeStreamResponse>;
	appendStream(args: {
		channel: string;
		ts: string;
		chunks: TaskUpdateChunk[];
	}): Promise<unknown>;
	stopStream(args: { channel: string; ts: string }): Promise<unknown>;
	deleteMessage(args: { channel: string; ts: string }): Promise<unknown>;
}

export interface SlackNativeProgressOptions {
	api: SlackNativeProgressApi;
	channel: string;
	threadTs: string;
	mode: ToolStreamingMode;
	verbose: boolean;
	recipientTeamId?: string;
	recipientUserId?: string;
	fallback: (label: string, show: boolean) => Promise<void>;
	warn?: (message: string, error: unknown) => void;
}

/**
 * Renders sanitized tool lifecycle as Slack-native task cards.
 *
 * This class intentionally accepts labels and status only. Raw tool arguments,
 * results, paths, and other execution details never enter the streaming API.
 */
export class SlackNativeProgress {
	private streamTs: string | undefined;
	private readonly visibleTasks = new Set<string>();
	private readonly fallbackTasks = new Set<string>();
	private readonly segmentTimestamps: string[] = [];
	private nativeDisabled = false;

	constructor(private readonly options: SlackNativeProgressOptions) {}

	async update(update: ToolProgressUpdate): Promise<void> {
		if (update.status === "in_progress") {
			if (!this.shouldSurface(update.show === true)) return;
			this.visibleTasks.add(update.id);
		} else if (!this.visibleTasks.has(update.id)) {
			return;
		}

		if (this.nativeDisabled) {
			await this.fallback(update);
			return;
		}

		const chunk: TaskUpdateChunk = {
			type: "task_update",
			id: update.id,
			title: update.label,
			status: update.status,
		};

		try {
			if (!this.streamTs) {
				const response = await this.options.api.startStream({
					channel: this.options.channel,
					thread_ts: this.options.threadTs,
					chunks: [chunk],
					task_display_mode: "timeline",
					...(this.options.recipientTeamId && this.options.recipientUserId
						? {
							recipient_team_id: this.options.recipientTeamId,
							recipient_user_id: this.options.recipientUserId,
						}
						: {}),
				});
				if (!response.ts) throw new Error("Slack stream started without a timestamp");
				this.streamTs = response.ts;
				this.segmentTimestamps.push(response.ts);
			} else {
				await this.options.api.appendStream({
					channel: this.options.channel,
					ts: this.streamTs,
					chunks: [chunk],
				});
			}
		} catch (error) {
			this.nativeDisabled = true;
			this.options.warn?.("Slack native progress unavailable; using message fallback", error);
			await this.stopCurrentStream();
			await this.fallback(update);
		}
	}

	async finalizeSegment(): Promise<void> {
		await this.stopCurrentStream();
		this.visibleTasks.clear();
		this.fallbackTasks.clear();
	}

	async deleteAll(): Promise<void> {
		await this.stopCurrentStream();
		for (const ts of this.segmentTimestamps.splice(0)) {
			try {
				await this.options.api.deleteMessage({ channel: this.options.channel, ts });
			} catch (error) {
				this.options.warn?.("Failed to delete Slack native progress message", error);
			}
		}
		this.visibleTasks.clear();
		this.fallbackTasks.clear();
	}

	private shouldSurface(show: boolean): boolean {
		if (this.options.verbose) return true;
		if (this.options.mode === "all") return true;
		return this.options.mode === "important" && show;
	}

	private async fallback(update: ToolProgressUpdate): Promise<void> {
		if (update.status !== "in_progress" || this.fallbackTasks.has(update.id)) return;
		this.fallbackTasks.add(update.id);
		await this.options.fallback(update.label, update.show === true);
	}

	private async stopCurrentStream(): Promise<void> {
		const ts = this.streamTs;
		this.streamTs = undefined;
		if (!ts) return;
		try {
			await this.options.api.stopStream({ channel: this.options.channel, ts });
		} catch (error) {
			this.options.warn?.("Failed to stop Slack native progress stream", error);
		}
	}
}
