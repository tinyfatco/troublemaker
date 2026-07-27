import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
	POST_RUN_FOLLOW_UP_CHANNEL_ID,
} from "../attention/post-run-follow-up.js";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

/**
 * Headless delivery for finite post-run evaluations.
 *
 * Scheduling and durable claims live in the attention queue and follow-up
 * state. This adapter has no clock, poller, or outbound message authoring.
 */
export class FollowUpAdapter implements PlatformAdapter {
	readonly name = "follow-up";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Post-run Follow-up Evaluation (Internal)
This is a finite evaluation wake after an ordinary run, not a heartbeat, spontaneity pulse, or persistent-goal continuation.

Review the current context and determine the next reasonable action. A user-visible message is not implied. Use available tools only when the context warrants an action. Do not announce or promise another follow-up. If no action is needed, call yield_no_action.`;

	private handler!: MomHandler;
	private queue: MomEvent[] = [];
	private processing = false;

	constructor(private readonly workingDir: string) {}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		log.logInfo("Follow-up adapter ready");
	}

	async stop(): Promise<void> {}

	async postMessage(_channel: string, _text: string): Promise<string> {
		return String(Date.now());
	}
	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string): Promise<void> {}
	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		return String(Date.now());
	}
	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `follow-up:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	getUser(_userId: string): UserInfo | undefined {
		return undefined;
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		return channelId === POST_RUN_FOLLOW_UP_CHANNEL_ID
			? { id: POST_RUN_FOLLOW_UP_CHANNEL_ID, name: "follow-up" }
			: undefined;
	}

	getAllUsers(): UserInfo[] {
		return [];
	}

	getAllChannels(): ChannelInfo[] {
		return [{ id: POST_RUN_FOLLOW_UP_CHANNEL_ID, name: "follow-up" }];
	}

	enqueueEvent(event: MomEvent): boolean {
		if (event.channel !== POST_RUN_FOLLOW_UP_CHANNEL_ID) return false;
		if (this.queue.length >= 32) {
			log.logWarning(`Follow-up queue full, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		this.queue.push(event);
		void this.processQueue();
		return true;
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			while (this.queue.length > 0) {
				const event = this.queue.shift()!;
				try {
					await this.handler.handleEvent(event, this, true);
				} catch (error) {
					log.logWarning("Follow-up run failed", error instanceof Error ? error.message : String(error));
				}
			}
		} finally {
			this.processing = false;
		}
	}

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.rawText ?? event.text,
				user: event.user,
				userName: "follow-up",
				channel: event.channel,
				ts: event.ts,
				eventType: event.type,
				sourceEventType: event.sourceEventType,
				directlyAddressed: false,
				attachments: [],
			},
			channelName: "follow-up",
			channels: [],
			users: [],
			respond: async () => {},
			sendFinalResponse: async () => {},
			respondInThread: async () => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async () => {},
			deleteMessage: async () => {},
			restartWorking: async () => {},
		};
	}
}
