import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { MomSettingsManager } from "../context.js";
import type { ChannelPulse, PulseRecordMetadata } from "../engagement/channel-pulse.js";
import * as log from "../log.js";
import type { Attachment, ChannelStore } from "../store.js";
import { createTwoMessageContext } from "./context.js";
import { SlackNativeProgress } from "./slack-native-progress.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, SlackThreadTargetInfo, ThreadTranscriptMessage, UserInfo } from "./types.js";
import { markdownToSlackMrkdwn } from "./slack-format.js";

// ============================================================================
// Slack-specific types (internal to adapter)
// ============================================================================

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

export class ChannelQueue {
	private queue: Array<{ work: QueuedWork; resolve: () => void }> = [];
	private processing = false;

	enqueue(work: QueuedWork): Promise<void> {
		let resolve: () => void;
		const done = new Promise<void>((r) => { resolve = r; });
		this.queue.push({ work, resolve: resolve! });
		this.processNext();
		return done;
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const { work, resolve } = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		resolve();
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// SlackBase — abstract base class for Slack adapters
// ============================================================================

export interface SlackBaseConfig {
	botToken: string;
	workingDir: string;
	store: ChannelStore;
	pulse?: ChannelPulse;
	/**
	 * Optional Slack user-id allowlist for direct messages. When omitted, DMs
	 * retain the legacy allow-all behavior. An explicitly empty set denies every
	 * DM while leaving channel mentions and ambient observation untouched.
	 */
	allowedDmUserIds?: Iterable<string>;
	/** Called when a non-self message arrives and the agent might want to engage. */
	onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
}

export abstract class SlackBase implements PlatformAdapter {
	readonly name = "slack";
	readonly maxMessageLength = 40000;
	readonly formatInstructions = `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

When mentioning users, use <@username> format (e.g., <@mario>).`;

	protected webClient: WebClient;
	protected handler!: MomHandler;
	protected workingDir: string;
	protected store: ChannelStore;
	protected botUserId: string | null = null;
	protected startupTs: string | null = null;
	protected pulse?: ChannelPulse;
	protected onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
	private allowedDmUserIds?: ReadonlySet<string>;

	protected users = new Map<string, SlackUser>();
	protected channels = new Map<string, SlackChannel>();
	protected queues = new Map<string, ChannelQueue>();
	private channelRefreshes = new Set<string>();

	constructor(config: SlackBaseConfig) {
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.webClient = new WebClient(config.botToken);
		this.pulse = config.pulse;
		this.onAmbientMessage = config.onAmbientMessage;
		this.allowedDmUserIds = config.allowedDmUserIds === undefined
			? undefined
			: new Set(Array.from(config.allowedDmUserIds, (id) => id.trim()).filter(Boolean));
	}

	/** Whether this Slack identity may start or steer the agent through a DM. */
	protected acceptsDmFrom(userId: string): boolean {
		return this.allowedDmUserIds === undefined || this.allowedDmUserIds.has(userId);
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	// ==========================================================================
	// Abstract — subclasses implement connection lifecycle
	// ==========================================================================

	abstract start(): Promise<void>;
	abstract stop(): Promise<void>;

	// ==========================================================================
	// Shared startup sequence (call from subclass start())
	// ==========================================================================

	protected async initMetadata(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		// Update pulse with resolved bot user ID
		if (this.pulse) {
			this.pulse.setSelfId(this.botUserId);
		}

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		// Backfill runs in background — don't block adapter startup.
		// The adapter is functional without backfill; it only adds historical messages.
		this.backfillAllChannels().catch((err) => {
			log.logWarning("Background backfill failed", err instanceof Error ? err.message : String(err));
		});
	}

	protected markStarted(): void {
		this.startupTs = (Date.now() / 1000).toFixed(6);
		log.logConnected();
	}

	// ==========================================================================
	// PlatformAdapter implementation
	// ==========================================================================

	getUser(userId: string): UserInfo | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): UserInfo[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): ChannelInfo[] {
		return Array.from(this.channels.values());
	}

	/**
	 * Learn channels from live traffic so a post-start invitation works without
	 * restarting the adapter. The synchronous placeholder establishes ownership;
	 * the background lookup replaces it with Slack's display name.
	 */
	protected observeChannel(channelId: string): void {
		const existing = this.channels.get(channelId);
		if (existing && (channelId.startsWith("D") || existing.name !== channelId)) return;
		if (!existing) {
			this.channels.set(channelId, {
				id: channelId,
				name: channelId.startsWith("D") ? `DM:${channelId}` : channelId,
			});
		}

		if (channelId.startsWith("D") || this.channelRefreshes.has(channelId)) return;
		this.channelRefreshes.add(channelId);
		void this.webClient.conversations.info({ channel: channelId })
			.then((result) => {
				const channel = result.channel as { id?: string; name?: string } | undefined;
				if (channel?.name) {
					this.channels.set(channelId, { id: channel.id || channelId, name: channel.name });
				}
			})
			.catch((err) => {
				log.logWarning(`Failed to refresh Slack channel ${channelId}`, err instanceof Error ? err.message : String(err));
			})
			.finally(() => this.channelRefreshes.delete(channelId));
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text: markdownToSlackMrkdwn(text) });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text: markdownToSlackMrkdwn(text) });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text: markdownToSlackMrkdwn(text) });
		return result.ts as string;
	}

	async readThread(channel: string, threadTs: string, limit = 40): Promise<ThreadTranscriptMessage[]> {
		const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 40, 100));
		const rawMessages: Array<{ ts?: string; user?: string; bot_id?: string; username?: string; subtype?: string; text?: string }> = [];
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.replies({
				channel,
				ts: threadTs,
				limit: 100,
				cursor,
				inclusive: true,
			});
			rawMessages.push(...((result.messages || []) as Array<{ ts?: string; user?: string; bot_id?: string; username?: string; subtype?: string; text?: string }>));
			cursor = result.response_metadata?.next_cursor || undefined;
		} while (cursor && rawMessages.length < 500);

		const channelName = this.getChannel(channel)?.name || channel;
		const ordered = rawMessages
			.filter((message) => typeof message.ts === "string")
			.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
		const root = ordered.find((message) => message.ts === threadTs);
		let visible = ordered.slice(-boundedLimit);
		if (root && !visible.some((message) => message.ts === root.ts)) {
			visible = boundedLimit === 1 ? [root] : [root, ...visible.slice(-(boundedLimit - 1))];
		}

		return visible
			.map((message) => {
				const ts = message.ts as string;
				const userId = typeof message.user === "string"
					? message.user
					: typeof message.bot_id === "string"
						? message.bot_id
						: typeof message.username === "string"
							? message.username
							: "unknown";
				const user = this.getUser(userId);
				const isBot = Boolean(message.bot_id || message.subtype === "bot_message" || userId === this.botUserId);
				return {
					date: slackTimestampToIso(ts),
					ts,
					threadTs,
					channelId: channel,
					channelName,
					sender: user?.displayName || user?.userName || (isBot ? "Zip" : userId),
					text: typeof message.text === "string" ? message.text : "",
					isRoot: ts === threadTs,
					isBot,
					sourceEventType: "slack_conversations_replies",
				};
			});
	}

	async listThreads(limit = 20): Promise<SlackThreadTargetInfo[]> {
		const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
		const byTarget = new Map<string, SlackThreadTargetInfo & { participantSet: Set<string> }>();
		const channels = Array.from(this.channels.values()).filter((channel) => !channel.id.startsWith("D"));

		for (const channel of channels) {
			try {
				const result = await this.webClient.conversations.history({
					channel: channel.id,
					limit: Math.max(10, Math.min(50, boundedLimit * 2)),
				});
				for (const message of (result.messages || []) as SlackHistoryMessage[]) {
					const ts = typeof message.ts === "string" ? message.ts : undefined;
					if (!ts) continue;
					const threadTs = typeof message.thread_ts === "string" && message.thread_ts ? message.thread_ts : ts;
					if (!/^\d+\.\d+$/.test(threadTs)) continue;

					const sendTarget = `slack:${channel.id}:${threadTs}`;
					const participantSet = new Set<string>();
					const author = displayNameForSlackMessage(message, this.users, this.botUserId);
					if (author) participantSet.add(author);
					for (const participantId of message.reply_users || []) {
						const participant = this.users.get(participantId);
						participantSet.add(participant?.displayName || participant?.userName || participantId);
					}

					const existing = byTarget.get(sendTarget);
					const rootPreview = slackPreview(message.text);
					const lastSeen = slackTimestampToIso(message.latest_reply || ts);
					const messageCount = Math.max(1, Number(message.reply_count || 0) + 1);

					if (!existing) {
						byTarget.set(sendTarget, {
							channelId: channel.id,
							channelName: channel.name,
							threadTs,
							sendTarget,
							rootPreview,
							lastPreview: rootPreview,
							participants: [],
							participantSet,
							messageCount,
							lastSeen,
							source: "slack-api",
						});
						continue;
					}

					for (const participant of participantSet) existing.participantSet.add(participant);
					if (rootPreview && ts === threadTs) existing.rootPreview = rootPreview;
					existing.messageCount = Math.max(existing.messageCount, messageCount);
					if (!existing.lastSeen || lastSeen > existing.lastSeen) {
						existing.lastSeen = lastSeen;
						existing.lastPreview = rootPreview || existing.lastPreview;
					}
				}
			} catch (err) {
				log.logWarning(`Slack listThreads failed for ${channel.id}`, err instanceof Error ? err.message : String(err));
			}
		}

		return Array.from(byTarget.values())
			.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
			.slice(0, boundedLimit)
			.map(({ participantSet, ...thread }) => ({
				...thread,
				participants: Array.from(participantSet).slice(0, 4),
				rootPreview: thread.rootPreview || "(no text captured)",
				lastPreview: thread.lastPreview || thread.rootPreview || "(no text captured)",
			}));
	}

	protected slackPulseMetadata(channel: string, ts: string, threadTs?: string, directlyAddressed = false): PulseRecordMetadata {
		if (channel.startsWith("D")) return { messageId: ts, directlyAddressed };
		const rootThreadTs = threadTs ?? ts;
		return {
			messageId: ts,
			threadTs: rootThreadTs,
			replyTarget: `slack:${channel}:${rootThreadTs}`,
			directlyAddressed,
			replyTargetDescription: threadTs
				? "Slack thread containing this message"
				: "Slack thread rooted under this message",
		};
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.webClient.files.uploadV2({
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string, metadata: { threadTs?: string } = {}): void {
		const ch = this.channels.get(channel);
		const threadTs = metadata.threadTs ?? ts;
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			threadTs,
			channel: ch ? `slack:#${ch.name}` : `slack:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
		// Record own message in pulse so timeSinceMyLast is accurate
		if (this.pulse && this.botUserId) {
			this.pulse.record(channel, this.botUserId, text.length, text, this.slackPulseMetadata(channel, ts, metadata.threadTs));
		}
	}

	enqueueEvent(event: MomEvent): boolean {
		// Slack channel IDs start with C (channel), D (DM), or G (group)
		if (!/^[CDG]/.test(event.channel)) return false;

		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(async () => { await this.handler.handleEvent(event, this, true); });
		return true;
	}

	// ==========================================================================
	// Context creation
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
		const user = this.users.get(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[(?:EVENT|ATTENTION):([^:]+):/)?.[1] : undefined;

		const headerLine = eventFilename ? `_Starting event: ${eventFilename}_` : "";

		// Track thread messages and working message ID for respondInThread + deleteMessage
		const threadMessageTs: string[] = [];
		let workingMessageId: string | null = null;
		const settings = new MomSettingsManager(this.workingDir);
		const responsePlacement = settings.getSlackResponsePlacement();
		const useChannelPlacement = !event.channel.startsWith("D") && responsePlacement === "channel";
		const responseThreadTs = useChannelPlacement || event.channel.startsWith("D") ? undefined : event.threadTs;
		// Working UI and agent delivery share one locus. Thread placement is the
		// default; an explicit channel override also changes the suggested
		// send_message target so the old top-level/thread split cannot recur.
		const contextEvent: MomEvent = useChannelPlacement
			? {
				...event,
				threadTs: undefined,
				replyTarget: event.channel,
				replyTargetDescription: "Slack channel where this message arrived (top-level delivery configured)",
			}
			: event;
		// An ambient batch may span multiple Slack threads. In that case the
		// synthetic event has no threadTs, so fail closed instead of opening a
		// top-level harness stream in an unrelated conversation.
		const suppressAmbiguousAmbientHarness = event.sourceEventType === "ambient_evaluation" && !event.threadTs;
		const verbosity = suppressAmbiguousAmbientHarness ? "messages-only" : settings.getVerbose(event.channel, "slack");
		const toolStreaming = suppressAmbiguousAmbientHarness ? "off" : settings.getSlackToolStreaming();
		const postResponse = (channel: string, text: string) =>
			responseThreadTs && channel === event.channel
				? this.postInThread(channel, responseThreadTs, text)
				: this.postMessage(channel, text);

		const context = createTwoMessageContext(
			{
				post: postResponse,
				update: (ch, id, text) => this.updateMessage(ch, id, text),
				delete: (ch, id) => this.deleteMessage(ch, id),
				formatStatus: (text) => `_${text}_`,
				throttleMs: 0,
				maxLength: this.maxMessageLength,
			},
			{
				headerLine,
				event: contextEvent,
				user,
				channels: this.getAllChannels(),
				users: this.getAllUsers(),
				channelName: this.channels.get(event.channel)?.name,
				isEvent,
				verbose: verbosity,
				toolStreaming,
			},
			{
				onWorkingUpdate: (id) => {
					workingMessageId = id;
				},
				logBotResponse: (ch, text, ts) => this.logBotResponse(ch, text, ts, { threadTs: responseThreadTs }),
				respondInThread: async (text) => {
					const threadTs = responseThreadTs ?? workingMessageId;
					if (threadTs) {
						const ts = await this.postInThread(event.channel, threadTs, text);
						threadMessageTs.push(ts);
					}
				},
				uploadFile: (filePath, title) => this.uploadFile(event.channel, filePath, title),
				deleteMessages: async (wId, fId) => {
					for (let i = threadMessageTs.length - 1; i >= 0; i--) {
						try {
							await this.deleteMessage(event.channel, threadMessageTs[i]);
						} catch {
							// Ignore errors deleting thread messages
						}
					}
					threadMessageTs.length = 0;
					if (wId) await this.deleteMessage(event.channel, wId);
					if (fId) await this.deleteMessage(event.channel, fId);
				},
			},
		);

		const nativeThreadTs = event.channel.startsWith("D") ? event.ts : responseThreadTs;
		const isPersonInvocation = /^[UW][A-Z0-9]+$/i.test(event.user);
		const canUseNativeProgress = settings.getSlackNativeProgress()
			&& !isEvent
			&& event.directlyAddressed === true
			&& Boolean(nativeThreadTs)
			&& (event.channel.startsWith("D") || (isPersonInvocation && Boolean(event.teamId)));

		if (!canUseNativeProgress || !nativeThreadTs) return context;

		const nativeProgress = new SlackNativeProgress({
			api: {
				startStream: (args) => this.webClient.chat.startStream(args),
				appendStream: (args) => this.webClient.chat.appendStream(args),
				stopStream: (args) => this.webClient.chat.stopStream(args),
				deleteMessage: (args) => this.webClient.chat.delete(args),
			},
			channel: event.channel,
			threadTs: nativeThreadTs,
			mode: toolStreaming,
			verbose: verbosity === true,
			...(event.channel.startsWith("D")
				? {}
				: { recipientTeamId: event.teamId, recipientUserId: event.user }),
			fallback: (label, show) => context.respond(`_→ ${label}_`, false, { show }),
			warn: (message, error) => {
				log.logWarning(message, error instanceof Error ? error.message : String(error));
			},
		});

		return {
			...context,
			updateToolProgress: (update) => nativeProgress.update(update),
			restartWorking: async (nextHeaderLine?: string) => {
				await nativeProgress.finalizeSegment();
				await context.restartWorking(nextHeaderLine);
			},
			setWorking: async (working: boolean) => {
				if (!working) await nativeProgress.finalizeSegment();
				await context.setWorking(working);
			},
			deleteMessage: async () => {
				await nativeProgress.deleteAll();
				await context.deleteMessage();
			},
		};
	}

	// ==========================================================================
	// Shared event handling helpers
	// ==========================================================================

	protected getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	protected logUserMessage(event: MomEvent): Attachment[] {
		const user = this.users.get(event.user);
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		const ch = this.channels.get(event.channel);
		this.logToFile({
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			channel: ch ? `slack:#${ch.name}` : `slack:${event.channel}`,
			channelId: event.channel,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			threadTs: event.threadTs,
			sourceEventType: event.sourceEventType,
			directlyAddressed: event.directlyAddressed,
			replyTarget: event.replyTarget,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				// Only consider entries for this channel
				if (entry.ts && entry.channelId === channelId) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs,
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false;
			if (msg.user === this.botUserId) return true;
			// Keep bot messages — bots are just participants
			if (msg.subtype !== undefined && msg.subtype !== "file_share" && msg.subtype !== "bot_message") return false;
			if (!msg.user && !msg.bot_id) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		relevantMessages.reverse();

		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			const ch = this.channels.get(channelId);
			this.logToFile({
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				channel: ch ? `slack:#${ch.name}` : `slack:${channelId}`,
				channelId,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Backfill all channels we're a member of
		const channelsToBackfill: Array<[string, SlackChannel]> = Array.from(this.channels.entries());

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Fetch Users/Channels
	// ==========================================================================

	protected async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	protected async fetchChannels(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}

function slackTimestampToIso(ts: string): string {
	const [seconds, fractional = ""] = ts.split(".");
	const epochMs = Number(seconds) * 1000 + Math.floor(Number(`0.${fractional}`) * 1000);
	if (!Number.isFinite(epochMs)) return "";
	return new Date(epochMs).toISOString();
}

interface SlackHistoryMessage {
	ts?: string;
	thread_ts?: string;
	user?: string;
	bot_id?: string;
	username?: string;
	subtype?: string;
	text?: string;
	reply_count?: number;
	latest_reply?: string;
	reply_users?: string[];
}

function displayNameForSlackMessage(
	message: SlackHistoryMessage,
	users: Map<string, SlackUser>,
	botUserId: string | null,
): string {
	const userId = typeof message.user === "string"
		? message.user
		: typeof message.bot_id === "string"
			? message.bot_id
			: typeof message.username === "string"
				? message.username
				: "unknown";
	const user = users.get(userId);
	const isBot = Boolean(message.bot_id || message.subtype === "bot_message" || userId === botUserId);
	return user?.displayName || user?.userName || (isBot ? "Zip" : userId);
}

function slackPreview(text: unknown, maxLength = 120): string {
	if (typeof text !== "string") return "";
	const normalized = text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}
