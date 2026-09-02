/**
 * FollowUpAdapter — headless adapter for agent-global idle evaluations.
 *
 * Checkpoints carry no conversation or reply target. Ordinary harness output
 * is discarded; the model must choose an explicit send_message target when a
 * useful open loop exists or record silence with yield_no_action.
 */

import { appendFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

export class FollowUpAdapter implements PlatformAdapter {
	readonly name = "follow-up";
	readonly maxMessageLength = 100_000;
	readonly formatInstructions = `## Natural Follow-up Evaluation (Internal)
This is an agent-global headless checkpoint, not a direct user message and not part of any assumed conversation. Review open loops across the agent with list_channels and read_thread when useful. If one concise follow-up is warranted, call send_message exactly once with the appropriate explicit target. Otherwise call yield_no_action. Ordinary assistant text, working output, typing indicators, and harness errors are not delivered.`;

	private handler!: MomHandler;
	private queue: MomEvent[] = [];
	private processing = false;

	constructor(private config: { workingDir: string }) {}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		log.logInfo("Follow-up adapter ready");
	}

	async stop(): Promise<void> {}

	// Headless boundary: no platform operation can emit ordinary harness output.
	async postMessage(_channel: string, _text: string): Promise<string> { return String(Date.now()); }
	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string): Promise<void> {}
	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> { return String(Date.now()); }
	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	logToFile(entry: object): void {
		appendFileSync(join(this.config.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(_channel: string, _text: string, _ts: string): void {}
	getUser(_userId: string): UserInfo | undefined { return undefined; }
	getChannel(_channelId: string): ChannelInfo | undefined { return undefined; }
	getAllUsers(): UserInfo[] { return []; }
	getAllChannels(): ChannelInfo[] { return []; }

	enqueueEvent(event: MomEvent): boolean {
		if (!event.followUp || event.sourceEventType !== "follow_up") return false;
		if (this.queue.length >= 24) {
			log.logWarning(`[follow-ups] Headless queue full, discarding wake ${event.followUp.key}`);
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
				} catch (err) {
					log.logWarning("[follow-ups] Headless run failed", err instanceof Error ? err.message : String(err));
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
				threadTs: event.threadTs,
				replyTarget: event.replyTarget,
				replyTargetDescription: event.replyTargetDescription,
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
