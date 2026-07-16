import { appendFileSync, readFileSync } from "fs";
import { basename, join } from "path";
import { MomSettingsManager } from "../context.js";
import type { ChannelPulse } from "../engagement/channel-pulse.js";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { markdownToDiscordMarkdown, stripDiscordMentions } from "./discord-format.js";
import { createTwoMessageContext } from "./context.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// Discord REST API constants
// ============================================================================

const DISCORD_API = "https://discord.com/api/v10";

// ============================================================================
// DiscordBase — abstract base class for Discord adapters
// ============================================================================

export interface DiscordBaseConfig {
	botToken: string;
	applicationId: string;
	workingDir: string;
	pulse?: ChannelPulse;
	/**
	 * Optional inbound boundaries. Omitted lists do not add a restriction; an
	 * explicitly empty list denies that scope. User boundaries apply to every
	 * message, guild/channel boundaries only to guild messages, and the DM-user
	 * boundary only to DMs. Every applicable configured list must match.
	 */
	allowedGuildIds?: Iterable<string>;
	allowedChannelIds?: Iterable<string>;
	allowedUserIds?: Iterable<string>;
	allowedDmUserIds?: Iterable<string>;
	/** Called when a non-DM, non-mention message arrives and the agent might want to engage. */
	onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
	/** @internal Deterministic REST hooks used by adapter tests. */
	rest?: DiscordRestOptions;
}

export interface DiscordRestOptions {
	fetch?: typeof globalThis.fetch;
	sleep?: (delayMs: number) => Promise<void>;
	maxRateLimitRetries?: number;
	maxRetryAfterMs?: number;
	requestTimeoutMs?: number;
}

export type DiscordMessageTrigger = "dm" | "mention" | "reply" | "ambient";

/** Normalized MESSAGE_CREATE shape shared by the in-process and relay adapters. */
export interface DiscordGatewayMessagePayload {
	type: string;
	trigger?: DiscordMessageTrigger;
	channelId: string;
	channelName?: string;
	guildId: string | null;
	author: {
		id: string;
		username: string;
		global_name?: string | null;
		discriminator?: string;
	};
	content: string;
	rawContent?: string;
	messageId: string;
	isDM: boolean;
	isMentioned?: boolean;
	timestamp: string;
	botUserId?: string;
	referencedMessageId?: string;
}

interface DiscordInboundBoundaryInput {
	guildId: string | null;
	channelId: string;
	userId: string;
	isDM: boolean;
}

type QueuedWork = () => Promise<void>;

export abstract class DiscordBase implements PlatformAdapter {
	readonly name = "discord";
	readonly maxMessageLength = 2000;
	readonly formatInstructions = `## Text Formatting
Use standard markdown: **bold**, *italic*, \`code\`, \`\`\`blocks\`\`\`, [links](url), ~~strikethrough~~.
When mentioning users, use <@userId> format.`;

	protected botToken: string;
	protected applicationId: string;
	protected handler!: MomHandler;
	protected workingDir: string;
	protected botUserId: string | null = null;
	protected pulse?: ChannelPulse;
	protected onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
	private allowedGuildIds?: ReadonlySet<string>;
	private allowedChannelIds?: ReadonlySet<string>;
	private allowedUserIds?: ReadonlySet<string>;
	private allowedDmUserIds?: ReadonlySet<string>;
	private restFetch: typeof globalThis.fetch;
	private restSleep: (delayMs: number) => Promise<void>;
	private restMaxRateLimitRetries: number;
	private restMaxRetryAfterMs: number;
	private restRequestTimeoutMs: number;
	private recentBotMessageIds = new Set<string>();

	// Track users/channels we've seen
	protected users = new Map<string, UserInfo>();
	protected channels = new Map<string, ChannelInfo>();
	private queues = new Map<string, QueuedWork[]>();
	private processing = new Map<string, boolean>();

	constructor(config: DiscordBaseConfig) {
		this.botToken = config.botToken;
		this.applicationId = config.applicationId;
		this.workingDir = config.workingDir;
		this.botUserId = config.applicationId;
		this.pulse = config.pulse;
		this.onAmbientMessage = config.onAmbientMessage;
		this.allowedGuildIds = optionalIdSet(config.allowedGuildIds);
		this.allowedChannelIds = optionalIdSet(config.allowedChannelIds);
		this.allowedUserIds = optionalIdSet(config.allowedUserIds);
		this.allowedDmUserIds = optionalIdSet(config.allowedDmUserIds);
		this.restFetch = config.rest?.fetch ?? globalThis.fetch;
		this.restSleep = config.rest?.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
		this.restMaxRateLimitRetries = boundedInteger(config.rest?.maxRateLimitRetries, 2, 0, 10);
		this.restMaxRetryAfterMs = boundedInteger(config.rest?.maxRetryAfterMs, 60_000, 0, 15 * 60_000);
		this.restRequestTimeoutMs = boundedInteger(config.rest?.requestTimeoutMs, 15_000, 1, 5 * 60_000);
		this.pulse?.setSelfId(this.botUserId);
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
	// Discord REST API helpers
	// ==========================================================================

	protected async discordFetch(
		path: string,
		options: RequestInit = {},
	): Promise<Response> {
		const url = `${DISCORD_API}${path}`;
		const routeLabel = describeDiscordRoute(path);
		const method = (options.method || "GET").toUpperCase();
		const headers = new Headers(options.headers);
		headers.set("authorization", `Bot ${this.botToken}`);
		headers.set("user-agent", "DiscordBot (https://github.com/tinyfatco/troublemaker, 0.1.0)");

		// Add content-type for JSON bodies
		if (options.body && typeof options.body === "string" && !headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}

		for (let attempt = 0; ; attempt++) {
			const timeoutController = new AbortController();
			const timeout = setTimeout(() => timeoutController.abort(), this.restRequestTimeoutMs);
			const callerSignal = options.signal;
			const abortFromCaller = () => timeoutController.abort();
			if (callerSignal?.aborted) timeoutController.abort();
			callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

			let resp: Response;
			try {
				resp = await this.restFetch(url, { ...options, headers, signal: timeoutController.signal });
			} catch (error) {
				const kind = error instanceof Error ? error.name : "unknown error";
				log.logWarning(`[discord] REST ${method} ${routeLabel} failed (${kind})`);
				throw new Error(`Discord REST ${method} ${routeLabel} failed`, { cause: error });
			} finally {
				clearTimeout(timeout);
				callerSignal?.removeEventListener("abort", abortFromCaller);
			}

			if (resp.status !== 429) {
				if (!resp.ok) {
					log.logWarning(`[discord] REST ${method} ${routeLabel} returned HTTP ${resp.status}`);
					throw new Error(`Discord REST ${method} ${routeLabel} returned HTTP ${resp.status}`);
				}
				return resp;
			}

			if (attempt >= this.restMaxRateLimitRetries) {
				log.logWarning(`[discord] REST ${method} ${routeLabel} remained rate limited after ${attempt + 1} attempts`);
				throw new Error(`Discord REST ${method} ${routeLabel} returned HTTP 429 after ${attempt + 1} attempts`);
			}

			const retryAfterMs = await readRetryAfterMs(resp);
			if (retryAfterMs === null || retryAfterMs > this.restMaxRetryAfterMs) {
				log.logWarning(`[discord] REST ${method} ${routeLabel} returned an unusable retry delay; not retrying`);
				throw new Error(`Discord REST ${method} ${routeLabel} returned HTTP 429 with an unusable retry delay`);
			}

			log.logWarning(`[discord] REST ${method} ${routeLabel} rate limited; retrying in ${Math.ceil(retryAfterMs)}ms (attempt ${attempt + 2}/${this.restMaxRateLimitRetries + 1})`);
			await this.restSleep(retryAfterMs);
		}
	}

	// ==========================================================================
	// Shared inbound MESSAGE_CREATE normalization and boundaries
	// ==========================================================================

	/** Whether an inbound identity/channel tuple crosses every applicable configured boundary. */
	protected acceptsIncomingDiscordMessage(input: DiscordInboundBoundaryInput): boolean {
		if (this.allowedUserIds !== undefined && !this.allowedUserIds.has(input.userId)) return false;
		if (input.isDM) {
			return this.allowedDmUserIds === undefined || this.allowedDmUserIds.has(input.userId);
		}
		return input.guildId !== null
			&& (this.allowedGuildIds === undefined || this.allowedGuildIds.has(input.guildId))
			&& (this.allowedChannelIds === undefined || this.allowedChannelIds.has(input.channelId));
	}

	protected acceptsDiscordGuild(guildId: string): boolean {
		return this.allowedGuildIds === undefined || this.allowedGuildIds.has(guildId);
	}

	protected acceptsDiscordChannel(channelId: string): boolean {
		return this.allowedChannelIds === undefined || this.allowedChannelIds.has(channelId);
	}

	protected setDiscordBotUserId(userId: string): void {
		if (!userId) return;
		this.botUserId = userId;
		this.pulse?.setSelfId(userId);
	}

	protected observeDiscordChannel(channelId: string, name?: string): void {
		if (!channelId) return;
		const previous = this.channels.get(channelId);
		this.channels.set(channelId, { id: channelId, name: name?.trim() || previous?.name || channelId });
	}

	protected forgetDiscordChannel(channelId: string): void {
		this.channels.delete(channelId);
	}

	protected isKnownBotMessage(messageId: string | undefined): boolean {
		return !!messageId && this.recentBotMessageIds.has(messageId);
	}

	/**
	 * Normalize and route a classified Discord message. Boundary rejection occurs
	 * before metadata, pulse, or workspace logging, matching isolated-agent DM
	 * behavior in the Slack Socket adapter.
	 */
	async handleGatewayMessage(payload: DiscordGatewayMessagePayload): Promise<boolean> {
		if (!isDiscordGatewayMessagePayload(payload)) {
			log.logWarning("[discord] Ignoring malformed normalized message payload");
			return false;
		}

		const { channelId, author, messageId, isDM } = payload;
		const trigger = payload.trigger || (isDM ? "dm" : "mention");
		const content = payload.content || "";
		const rawContent = payload.rawContent || content;
		const displayName = author.global_name || author.username;

		if (!content.trim()) return false;
		if (!this.acceptsIncomingDiscordMessage({
			guildId: payload.guildId,
			channelId,
			userId: author.id,
			isDM,
		})) {
			log.logInfo("[discord] Ignoring message outside configured inbound boundaries");
			return false;
		}

		if (payload.botUserId) this.setDiscordBotUserId(payload.botUserId);

		log.logInfo(`[discord] Gateway message: ${trigger} from ${displayName}: ${content.substring(0, 80)}`);

		this.users.set(author.id, { id: author.id, userName: author.username, displayName });
		this.observeDiscordChannel(channelId, payload.channelName || (isDM ? `DM with ${displayName}` : undefined));

		this.pulse?.record(channelId, author.id, rawContent.length, rawContent, { messageId, directlyAddressed: trigger !== "ambient" });

		const replyTargetDescription = isDM
			? "Discord DM"
			: trigger === "ambient"
				? "Discord channel containing this ambient message; use only if a visible reply is appropriate"
				: trigger === "reply"
					? "Discord channel containing this reply to the bot"
					: "Discord channel where this message arrived";
		const momEvent: MomEvent = {
			type: isDM ? "dm" : "mention",
			channel: channelId,
			ts: messageId,
			user: author.id,
			text: stripDiscordMentions(content),
			rawText: rawContent,
			sourceEventType: `discord_${trigger}`,
			directlyAddressed: trigger !== "ambient",
			replyTarget: `discord:${channelId}`,
			replyTargetDescription,
		};

		this.logToFile({
			date: new Date().toISOString(),
			ts: messageId,
			channel: `discord:${isDM ? "DM" : this.channels.get(channelId)?.name || channelId}`,
			channelId,
			user: author.id,
			userName: author.username,
			displayName,
			text: rawContent,
			attachments: [],
			isBot: false,
		});

		if (!isDM && trigger === "ambient") {
			this.onAmbientMessage?.(channelId, momEvent, this);
			return true;
		}

		if (this.handler.resolvePendingInput(channelId, momEvent.text)) return true;
		if (await this.handler.handleSlashCommand(momEvent, this)) return true;

		if (momEvent.text.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(channelId)) {
				void this.handler.handleStop(channelId, this, momEvent).catch((error) => {
					log.logWarning("[discord] Stop response failed", error instanceof Error ? error.message : String(error));
				});
			}
			return true;
		}

		if (this.handler.isRunning(channelId)) {
			this.handler.handleSteer(momEvent, this);
		} else {
			this.enqueueWork(channelId, async () => { await this.handler.handleEvent(momEvent, this); });
		}
		return true;
	}

	// ==========================================================================
	// Interaction response helpers (used by webhook adapter)
	// ==========================================================================

	/**
	 * Edit the original deferred interaction response.
	 * Used as the "final response" in the two-message pattern.
	 */
	async editInteractionResponse(interactionToken: string, content: string): Promise<void> {
		const chunks = chunkText(content, this.maxMessageLength);
		// Edit original with first chunk
		await this.discordFetch(
			`/webhooks/${this.applicationId}/${interactionToken}/messages/@original`,
			{
				method: "PATCH",
				body: JSON.stringify({ content: markdownToDiscordMarkdown(chunks[0]) }),
			},
		);
		// Send remaining chunks as follow-ups
		for (let i = 1; i < chunks.length; i++) {
			await this.discordFetch(
				`/webhooks/${this.applicationId}/${interactionToken}`,
				{
					method: "POST",
					body: JSON.stringify({ content: markdownToDiscordMarkdown(chunks[i]) }),
				},
			);
		}
	}

	/**
	 * Send a follow-up message to an interaction.
	 * Returns the message ID.
	 */
	async sendFollowup(interactionToken: string, content: string): Promise<string> {
		const chunks = chunkText(content, this.maxMessageLength);
		let lastId = "";
		for (const chunk of chunks) {
			const resp = await this.discordFetch(
				`/webhooks/${this.applicationId}/${interactionToken}`,
				{
					method: "POST",
					body: JSON.stringify({ content: markdownToDiscordMarkdown(chunk) }),
				},
			);
			lastId = await readDiscordMessageId(resp);
		}
		return lastId;
	}

	/**
	 * Edit a follow-up message.
	 */
	async editFollowup(interactionToken: string, messageId: string, content: string): Promise<void> {
		const truncated = content.length > this.maxMessageLength
			? content.substring(0, this.maxMessageLength - 3) + "..."
			: content;
		await this.discordFetch(
			`/webhooks/${this.applicationId}/${interactionToken}/messages/${messageId}`,
			{
				method: "PATCH",
				body: JSON.stringify({ content: markdownToDiscordMarkdown(truncated) }),
			},
		);
	}

	/**
	 * Delete a follow-up message.
	 */
	async deleteFollowup(interactionToken: string, messageId: string): Promise<void> {
		await this.discordFetch(
			`/webhooks/${this.applicationId}/${interactionToken}/messages/${messageId}`,
			{ method: "DELETE" },
		);
	}

	// ==========================================================================
	// PlatformAdapter — standard message operations (channel-based)
	// These are used by ping/send_message tool for cross-channel messaging.
	// ==========================================================================

	async postMessage(channel: string, text: string): Promise<string> {
		const chunks = chunkText(text, this.maxMessageLength);
		let lastId = "";
		for (const chunk of chunks) {
			const resp = await this.discordFetch(`/channels/${channel}/messages`, {
				method: "POST",
				body: JSON.stringify({ content: markdownToDiscordMarkdown(chunk) }),
			});
			lastId = await readDiscordMessageId(resp);
		}
		return lastId;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		const truncated = text.length > this.maxMessageLength
			? text.substring(0, this.maxMessageLength - 3) + "..."
			: text;
		await this.discordFetch(`/channels/${channel}/messages/${ts}`, {
			method: "PATCH",
			body: JSON.stringify({ content: markdownToDiscordMarkdown(truncated) }),
		});
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		try {
			await this.discordFetch(`/channels/${channel}/messages/${ts}`, {
				method: "DELETE",
			});
		} catch {
			// Ignore errors (message may already be deleted)
		}
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		// Discord threads are channels — post with message_reference
		const resp = await this.discordFetch(`/channels/${channel}/messages`, {
			method: "POST",
			body: JSON.stringify({
				content: markdownToDiscordMarkdown(text.substring(0, this.maxMessageLength)),
				message_reference: { message_id: threadTs },
			}),
		});
		return readDiscordMessageId(resp);
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		const boundary = `----FormBoundary${Date.now()}`;

		const parts: Buffer[] = [];
		// File part
		parts.push(Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
		));
		parts.push(fileContent);
		parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

		const body = Buffer.concat(parts);

		await this.discordFetch(`/channels/${channel}/messages`, {
			method: "POST",
			headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
			body,
		});
	}

	// ==========================================================================
	// Logging
	// ==========================================================================

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		if (ts) {
			this.recentBotMessageIds.add(ts);
			if (this.recentBotMessageIds.size > 256) {
				const oldest = this.recentBotMessageIds.values().next().value as string | undefined;
				if (oldest) this.recentBotMessageIds.delete(oldest);
			}
		}
		const ch = this.channels.get(channel);
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: ch ? `discord:#${ch.name}` : `discord:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
		const selfId = this.botUserId || this.applicationId;
		this.pulse?.record(channel, selfId, text.length, text, { messageId: ts });
	}

	// ==========================================================================
	// Metadata
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

	enqueueEvent(event: MomEvent): boolean {
		// Discord snowflake IDs are 17-20 digit numbers
		if (!/^\d{17,20}$/.test(event.channel)) return false;

		const queue = this.queues.get(event.channel) || [];
		if (queue.length >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		this.enqueueWork(event.channel, async () => { await this.handler.handleEvent(event, this, true); });
		return true;
	}

	// ==========================================================================
	// Context creation
	// ==========================================================================

	/**
	 * Create a context for interaction-based messages.
	 * The interaction token is stored in the event metadata and used
	 * for the two-message pattern (deferred response → follow-up).
	 */
	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
		const user = this.users.get(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[(?:EVENT|ATTENTION):([^:]+):/)?.[1] : undefined;
		const headerLine = eventFilename
			? `*Starting event: ${eventFilename}*`
			: "*Thinking*";

		// Extract interaction token from event metadata (set by webhook adapter)
		const interactionToken = (event as any)._interactionToken as string | undefined;

		// If we have an interaction token, use interaction-based messaging.
		// Otherwise fall back to channel-based messaging (e.g., from events system).
		// Escape underscores in status text so Discord doesn't interpret them as italics
		const formatStatus = (text: string) => `*${text.replace(/_/g, "\\_")}*`;

		const ops = interactionToken
			? {
				post: async (ch: string, text: string) => {
					return await this.sendFollowup(interactionToken, text);
				},
				update: async (_ch: string, id: string, text: string) => {
					// id === "@original" means edit the deferred response
					if (id === "@original") {
						await this.editInteractionResponse(interactionToken, text);
					} else {
						await this.editFollowup(interactionToken, id, text);
					}
				},
				delete: async (_ch: string, id: string) => {
					if (id === "@original") return; // Don't delete the deferred response
					await this.deleteFollowup(interactionToken, id);
				},
				formatStatus,
				throttleMs: 0,
				maxLength: this.maxMessageLength,
			}
			: {
				post: (ch: string, text: string) => this.postMessage(ch, text),
				update: (ch: string, id: string, text: string) => this.updateMessage(ch, id, text),
				delete: (ch: string, id: string) => this.deleteMessage(ch, id),
				formatStatus,
				throttleMs: 0,
				maxLength: this.maxMessageLength,
			};

		return createTwoMessageContext(
			ops,
			{
				headerLine,
				event,
				user,
				channels: this.getAllChannels(),
				users: this.getAllUsers(),
				channelName: this.channels.get(event.channel)?.name,
				isEvent,
				verbose: new MomSettingsManager(this.workingDir).getVerbose(event.channel, "discord"),
			},
			{
				logBotResponse: (ch, text, ts) => this.logBotResponse(ch, text, ts),
				uploadFile: (filePath, title) => this.uploadFile(event.channel, filePath, title),
			},
		);
	}

	// ==========================================================================
	// Queue
	// ==========================================================================

	protected enqueueWork(channelId: string, work: QueuedWork): void {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = [];
			this.queues.set(channelId, queue);
		}
		queue.push(work);
		this.processQueue(channelId);
	}

	private async processQueue(channelId: string): Promise<void> {
		if (this.processing.get(channelId)) return;
		this.processing.set(channelId, true);

		const queue = this.queues.get(channelId);
		while (queue && queue.length > 0) {
			const work = queue.shift()!;
			try {
				await work();
			} catch (err) {
				log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
			}
		}

		this.processing.set(channelId, false);
	}
}

// ============================================================================
// Text chunking for Discord's 2000 char limit
// ============================================================================

function chunkText(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		// Try to break at a newline
		let breakPoint = remaining.lastIndexOf("\n", maxLength);
		if (breakPoint < maxLength * 0.5) {
			// No good newline break — try space
			breakPoint = remaining.lastIndexOf(" ", maxLength);
		}
		if (breakPoint < maxLength * 0.3) {
			// No good break point — hard cut
			breakPoint = maxLength;
		}

		chunks.push(remaining.substring(0, breakPoint));
		remaining = remaining.substring(breakPoint).trimStart();
	}

	return chunks;
}

function optionalIdSet(ids: Iterable<string> | undefined): ReadonlySet<string> | undefined {
	if (ids === undefined) return undefined;
	return new Set(Array.from(ids, (id) => id.trim()).filter(Boolean));
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`Discord configuration value must be an integer between ${min} and ${max}`);
	}
	return value;
}

function describeDiscordRoute(path: string): string {
	return path
		.split("?", 1)[0]
		.replace(/\/webhooks\/[^/]+\/[^/]+/, "/webhooks/:application/:token")
		.replace(/\b\d{17,20}\b/g, ":id");
}

async function readRetryAfterMs(response: Response): Promise<number | null> {
	const retryAfterHeader = response.headers.get("retry-after");
	if (retryAfterHeader !== null) {
		const headerSeconds = Number(retryAfterHeader);
		if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return headerSeconds * 1000;
	}

	try {
		const body = await response.clone().json() as { retry_after?: unknown };
		const bodySeconds = Number(body.retry_after);
		return Number.isFinite(bodySeconds) && bodySeconds >= 0 ? bodySeconds * 1000 : null;
	} catch {
		return null;
	}
}

async function readDiscordMessageId(response: Response): Promise<string> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error("Discord REST returned an invalid message response");
	}
	if (!body || typeof body !== "object" || typeof (body as { id?: unknown }).id !== "string" || !(body as { id: string }).id) {
		throw new Error("Discord REST returned an invalid message response");
	}
	return (body as { id: string }).id;
}

function isDiscordGatewayMessagePayload(payload: unknown): payload is DiscordGatewayMessagePayload {
	if (!payload || typeof payload !== "object") return false;
	const candidate = payload as Partial<DiscordGatewayMessagePayload>;
	if (candidate.type !== "message") return false;
	if (typeof candidate.channelId !== "string" || !candidate.channelId) return false;
	if (typeof candidate.messageId !== "string" || !candidate.messageId) return false;
	if (typeof candidate.content !== "string" || typeof candidate.isDM !== "boolean") return false;
	if (candidate.guildId !== null && typeof candidate.guildId !== "string") return false;
	if (candidate.isDM !== (candidate.guildId === null)) return false;
	if (candidate.trigger !== undefined && !isDiscordMessageTrigger(candidate.trigger)) return false;
	if (candidate.isDM && candidate.trigger !== undefined && candidate.trigger !== "dm") return false;
	if (!candidate.isDM && candidate.trigger === "dm") return false;
	if (candidate.channelName !== undefined && typeof candidate.channelName !== "string") return false;
	if (candidate.rawContent !== undefined && typeof candidate.rawContent !== "string") return false;
	if (candidate.timestamp !== undefined && typeof candidate.timestamp !== "string") return false;
	if (candidate.botUserId !== undefined && typeof candidate.botUserId !== "string") return false;
	if (candidate.referencedMessageId !== undefined && typeof candidate.referencedMessageId !== "string") return false;
	if (candidate.isMentioned !== undefined && typeof candidate.isMentioned !== "boolean") return false;
	if (!candidate.author || typeof candidate.author !== "object") return false;
	if (candidate.author.global_name !== undefined
		&& candidate.author.global_name !== null
		&& typeof candidate.author.global_name !== "string") return false;
	if (candidate.author.discriminator !== undefined && typeof candidate.author.discriminator !== "string") return false;
	return typeof candidate.author.id === "string"
		&& !!candidate.author.id
		&& typeof candidate.author.username === "string"
		&& !!candidate.author.username;
}

function isDiscordMessageTrigger(value: unknown): value is DiscordMessageTrigger {
	return value === "dm" || value === "mention" || value === "reply" || value === "ambient";
}
