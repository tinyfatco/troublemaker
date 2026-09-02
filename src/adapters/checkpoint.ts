import { appendFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

export interface HeadlessCheckpointOptions {
	name: string;
	channelName: string;
	workingDir: string;
	formatInstructions: string;
	maxMessageLength?: number;
	queueLimit: number;
	channels?: ChannelInfo[];
	acceptsEvent: (event: MomEvent) => boolean;
	prepareEvent?: (event: MomEvent) => MomEvent | null | Promise<MomEvent | null>;
	createMessage: (event: MomEvent) => MomContext["message"];
	startLog: string;
	queueFullLog: (event: MomEvent) => string;
	eventEnqueuedLog?: (event: MomEvent) => string;
	runFailedLog: string;
	botResponseEntry?: (channel: string, text: string, ts: string) => object;
}

/**
 * Shared execution boundary for internal attention checkpoints.
 *
 * Scheduling, durable claims, recurrence, and prompt semantics stay with each
 * checkpoint owner. This primitive only owns the bounded sequential queue and
 * the headless platform surface that prevents ordinary harness output.
 */
export class HeadlessCheckpointAdapter implements PlatformAdapter {
	readonly name: string;
	readonly maxMessageLength: number;
	readonly formatInstructions: string;

	private handler!: MomHandler;
	private queue: MomEvent[] = [];
	private processing = false;

	constructor(private readonly options: HeadlessCheckpointOptions) {
		this.name = options.name;
		this.maxMessageLength = options.maxMessageLength ?? 100_000;
		this.formatInstructions = options.formatInstructions;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		log.logInfo(this.options.startLog);
	}

	async stop(): Promise<void> {}

	// Internal checkpoints never deliver ordinary harness output directly.
	async postMessage(_channel: string, _text: string): Promise<string> { return String(Date.now()); }
	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string, _text?: string): Promise<void> {}
	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> { return String(Date.now()); }
	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	logToFile(entry: object): void {
		appendFileSync(join(this.options.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		const entry = this.options.botResponseEntry?.(channel, text, ts);
		if (entry) this.logToFile(entry);
	}

	getUser(_userId: string): UserInfo | undefined { return undefined; }

	getChannel(channelId: string): ChannelInfo | undefined {
		const channel = this.options.channels?.find((candidate) => candidate.id === channelId);
		return channel ? { ...channel } : undefined;
	}

	getAllUsers(): UserInfo[] { return []; }
	getAllChannels(): ChannelInfo[] { return (this.options.channels ?? []).map((channel) => ({ ...channel })); }

	enqueueEvent(event: MomEvent): boolean {
		if (!this.options.acceptsEvent(event)) return false;
		if (this.queue.length >= this.options.queueLimit) {
			log.logWarning(this.options.queueFullLog(event));
			return false;
		}
		if (this.options.eventEnqueuedLog) {
			log.logInfo(this.options.eventEnqueuedLog(event));
		}
		this.queue.push(event);
		void this.processQueue();
		return true;
	}

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: this.options.createMessage(event),
			channelName: this.options.channelName,
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

	protected async runCheckpoint(event: MomEvent): Promise<void> {
		const prepared = this.options.prepareEvent
			? await this.options.prepareEvent(event)
			: event;
		if (prepared) await this.handler.handleEvent(prepared, this, true);
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			while (this.queue.length > 0) {
				const event = this.queue.shift()!;
				try {
					await this.runCheckpoint(event);
				} catch (error) {
					log.logWarning(
						this.options.runFailedLog,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
		} finally {
			this.processing = false;
		}
	}
}
