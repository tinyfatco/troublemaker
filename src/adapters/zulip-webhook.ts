import { timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import TurndownService from "turndown";
import type { WorkingOutputTarget } from "../context.js";
import type { ChannelPulse, PulseRecordMetadata } from "../engagement/channel-pulse.js";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { withHostReceipt, type HostDeliveryReceipt } from "./host-receipt.js";
import type {
	ChannelInfo,
	MomContext,
	MomEvent,
	MomHandler,
	PlatformAdapter,
	UserInfo,
	WorkingOutputContextOptions,
} from "./types.js";
import {
	createWorkspaceMessageContext,
	createWorkspaceWorkingOutputContext,
	type WorkspaceChannelTransport,
} from "./workspace-channel-context.js";
import {
	routeWorkspaceChannelEvent,
	WorkspaceChannelQueue,
	WorkspaceDeliveryLedger,
} from "./workspace-channel-runtime.js";
import {
	formatZulipDmChannel,
	formatZulipTopicTarget,
	isZulipChannelId,
	parseZulipDmChannel,
} from "./zulip-target.js";

interface ZulipUser {
	user_id: number;
	email: string;
	full_name: string;
	is_bot?: boolean;
}

interface ZulipChannel {
	stream_id: number;
	name: string;
	topics_policy?: string;
}

interface ZulipDirectRecipient {
	id: number;
	email: string;
	full_name: string;
}

interface ZulipMessageBase {
	id: number;
	sender_id: number;
	sender_email: string;
	sender_full_name: string;
	sender_is_bot?: boolean;
	timestamp: number;
	content: string;
	raw_content?: string;
	is_mentioned?: boolean;
	flags?: string[];
}

interface ZulipStreamMessage extends ZulipMessageBase {
	type: "stream";
	stream_id: number;
	display_recipient: string;
	subject: string;
}

interface ZulipDirectMessage extends ZulipMessageBase {
	type: "private";
	recipient_id: number;
	display_recipient: ZulipDirectRecipient[];
	subject?: string;
}

type ZulipMessage = ZulipStreamMessage | ZulipDirectMessage;

interface ZulipResponse {
	result: "success";
	msg: string;
	id?: number;
	uri?: string;
}

interface ZulipKnownUser extends UserInfo {
	isBot?: boolean;
}

export interface ZulipWebhookConfig {
	url: string;
	botToken: string;
	inboundToken: string;
	agentName: string;
	workingDir: string;
	store: ChannelStore;
	/** Optional extra stream allowlist. Omit it to follow the bot's live Zulip subscriptions. */
	allowedChannelIds?: Iterable<string>;
	/** Optional sender allowlist for individual and group direct messages. */
	allowedDmUserIds?: Iterable<string>;
	pulse?: ChannelPulse;
	directChannelMessages?: boolean;
	onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
}

/**
 * Host-managed Zulip transport for subscribed channels and direct messages.
 *
 * The configured URL is a host capability proxy, not the native Zulip URL.
 * The host keeps provider credentials and the private user directory outside
 * the resident while exposing only its current subscriptions and established
 * direct-message conversations.
 */
export class ZulipWebhookAdapter implements PlatformAdapter {
	readonly name = "zulip";
	readonly maxMessageLength = 10_000;
	readonly formatInstructions = `## Zulip Formatting (Markdown)
Use standard Markdown. Reply to direct messages directly and preserve the inbound topic when a channel uses topics.`;

	private readonly apiBase: string;
	private readonly botToken: string;
	private readonly inboundToken: string;
	private readonly agentName: string;
	private readonly workingDir: string;
	private readonly store: ChannelStore;
	private readonly pulse?: ChannelPulse;
	private readonly allowedChannelIds?: ReadonlySet<string>;
	private readonly allowedDmUserIds?: ReadonlySet<string>;
	private readonly directChannelMessages: boolean;
	private readonly onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
	private readonly users = new Map<string, ZulipKnownUser>();
	private readonly channels = new Map<string, ChannelInfo>();
	private readonly channelPolicies = new Map<string, string>();
	private readonly turndown = new TurndownService({ codeBlockStyle: "fenced" });
	private readonly queues = new Map<string, WorkspaceChannelQueue>();
	private readonly deliveryLedger: WorkspaceDeliveryLedger;
	private handler!: MomHandler;
	private botUserId: string | null = null;
	private botEmail: string | null = null;

	constructor(config: ZulipWebhookConfig) {
		const parsed = new URL(config.url);
		if (!["http:", "https:"].includes(parsed.protocol)) {
			throw new Error("Zulip URL must use http:// or https://");
		}
		this.apiBase = `${parsed.toString().replace(/\/$/, "")}/api/v1`;
		this.botToken = config.botToken;
		this.inboundToken = config.inboundToken;
		this.agentName = config.agentName;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.pulse = config.pulse;
		this.directChannelMessages = config.directChannelMessages ?? true;
		this.onAmbientMessage = config.onAmbientMessage;
		this.allowedChannelIds = config.allowedChannelIds === undefined
			? undefined
			: new Set(Array.from(config.allowedChannelIds, (channelId) => channelId.trim()).filter(Boolean));
		this.allowedDmUserIds = config.allowedDmUserIds === undefined
			? undefined
			: new Set(Array.from(config.allowedDmUserIds, (userId) => userId.trim()).filter(Boolean));
		for (const channelId of this.allowedChannelIds || []) {
			if (!isZulipChannelId(channelId)) {
				throw new Error("Zulip allowed channel IDs must be positive integers");
			}
		}
		for (const userId of this.allowedDmUserIds || []) {
			if (!/^[1-9]\d*$/.test(userId)) {
				throw new Error("Zulip allowed DM user IDs must be positive integers");
			}
		}
		this.deliveryLedger = new WorkspaceDeliveryLedger(
			join(this.workingDir, "zulip-inbound-deliveries.jsonl"),
			"Zulip delivery ledger is unreadable",
		);
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("ZulipWebhookAdapter: handler not set");
		const me = await this.api<ZulipUser & ZulipResponse>("/users/me");
		this.botUserId = String(me.user_id);
		this.botEmail = me.email;
		this.rememberUser(me);
		const result = await this.api<ZulipResponse & { streams: ZulipChannel[] }>(
			"/streams?include_public=true&include_subscribed=true&include_all_active=true",
		);
		for (const stream of result.streams) {
			const channelId = String(stream.stream_id);
			if (!this.streamIsInScope(channelId)) continue;
			this.channels.set(channelId, { id: channelId, name: stream.name });
			if (stream.topics_policy) this.channelPolicies.set(channelId, stream.topics_policy);
		}
		for (const channelId of this.allowedChannelIds || []) {
			if (!this.channels.has(channelId)) {
				throw new Error(`Zulip host proxy omitted allowed channel ${channelId}`);
			}
		}
		this.restoreKnownDirectConversations();
		this.pulse?.setSelfId(this.botUserId);
		log.logConnected();
	}

	async stop(): Promise<void> {}

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

	async postMessage(
		channel: string,
		text: string,
		attachments: Array<{ filePath: string; filename: string }> = [],
	): Promise<string> {
		let content = text;
		for (const attachment of attachments) {
			const form = new FormData();
			form.append("file", new Blob([readFileSync(attachment.filePath)]), attachment.filename);
			const uploaded = await this.api<ZulipResponse>("/user_uploads", {
				method: "POST",
				body: form,
			});
			if (!uploaded.uri) throw new Error("Zulip upload response omitted the file URI");
			content += `${content ? "\n\n" : ""}[${attachment.filename}](${uploaded.uri})`;
		}
		const directRecipients = parseZulipDmChannel(channel);
		const body = directRecipients
			? new URLSearchParams({ type: "direct", to: JSON.stringify(directRecipients.map(Number)), content })
			: new URLSearchParams({
				type: "channel",
				to: this.requireKnownStream(channel),
				topic: this.defaultTopic(channel),
				content,
			});
		return this.sendMessageBody(body);
	}

	async postInThread(channel: string, topic: string, text: string): Promise<string> {
		if (parseZulipDmChannel(channel)) return this.postMessage(channel, text);
		const body = new URLSearchParams({
			type: "channel",
			to: this.requireKnownStream(channel),
			topic,
			content: text,
		});
		return this.sendMessageBody(body);
	}

	async postResponseMessage(event: MomEvent, text: string): Promise<string> {
		return event.threadTs
			? this.postInThread(event.channel, event.threadTs, text)
			: this.postMessage(event.channel, text);
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		this.requireKnownConversation(channel);
		await this.api(`/messages/${this.messageId(ts)}`, {
			method: "PATCH",
			body: new URLSearchParams({ content: text }),
		});
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		this.requireKnownConversation(channel);
		await this.api(`/messages/${this.messageId(ts)}`, { method: "DELETE" });
	}

	async uploadFile(channel: string, filePath: string, title?: string, topic?: string): Promise<void> {
		this.requireKnownConversation(channel);
		const filename = title || basename(filePath);
		const form = new FormData();
		form.append("file", new Blob([readFileSync(filePath)]), filename);
		const uploaded = await this.api<ZulipResponse>("/user_uploads", { method: "POST", body: form });
		if (!uploaded.uri) throw new Error("Zulip upload response omitted the file URI");
		const content = `[${filename}](${uploaded.uri})`;
		if (topic && !parseZulipDmChannel(channel)) await this.postInThread(channel, topic, content);
		else await this.postMessage(channel, content);
	}

	logBotResponse(channel: string, text: string, ts: string, metadata: { threadTs?: string } = {}): void {
		void this.store.logMessage({
			date: new Date().toISOString(),
			ts,
			threadTs: metadata.threadTs,
			channel: `zulip:${this.channels.get(channel)?.name || channel}`,
			channelId: channel,
			user: this.botUserId || "tinyfat-agent",
			userName: this.botEmail || "agent",
			displayName: this.agentName,
			text,
			attachments: [],
			isBot: true,
			directlyAddressed: true,
			sourceEventType: parseZulipDmChannel(channel) ? "zulip_agent_dm" : "zulip_agent_message",
		} as Parameters<ChannelStore["logMessage"]>[0]);
		if (this.pulse && this.botUserId) {
			this.pulse.record(channel, this.botUserId, text.length, text, this.pulseMetadata(channel, ts, true, metadata.threadTs));
		}
	}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	enqueueEvent(event: MomEvent): boolean {
		if (!this.channels.has(event.channel)) return false;
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Zulip event queue full for ${event.channel}`, event.text.substring(0, 80));
			return false;
		}
		queue.enqueue(async () => { await this.handler.handleEvent(event, this, true); });
		return true;
	}

	dispatch(request: IncomingMessage, response: ServerResponse): void {
		if (!matchesBearer(request.headers.authorization, this.inboundToken)) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		const chunks: Buffer[] = [];
		let length = 0;
		request.on("data", (chunk: Buffer) => {
			length += chunk.length;
			if (length <= 2 * 1024 * 1024) chunks.push(chunk);
		});
		request.on("end", () => {
			if (length > 2 * 1024 * 1024) {
				response.writeHead(413);
				response.end();
				return;
			}
			let payload: {
				deliveryId?: string;
				message?: ZulipMessage;
				hostReceipt?: HostDeliveryReceipt;
			};
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof payload;
			} catch {
				response.writeHead(400);
				response.end("Invalid JSON");
				return;
			}
			const message = payload.message;
			if (
				!message
				|| !Number.isInteger(message.id)
				|| !Number.isInteger(message.sender_id)
				|| !["stream", "private"].includes(message.type)
				|| (message.type === "stream" && !Number.isInteger(message.stream_id))
				|| (message.type === "private" && !Array.isArray(message.display_recipient))
			) {
				response.writeHead(400);
				response.end("Missing Zulip message");
				return;
			}
			if (message.type === "stream" && !this.streamIsInScope(String(message.stream_id))) {
				response.writeHead(403);
				response.end("Zulip message outside the configured stream scope");
				return;
			}
			response.writeHead(202, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, accepted: true }));
			void withHostReceipt(payload.hostReceipt, async () => {
				if (payload.deliveryId && this.deliveryLedger.has(payload.deliveryId)) return;
				if (message.type !== "private" || this.acceptsDmFrom(String(message.sender_id))) {
					await this.handleMessage(message, true);
				}
				if (payload.deliveryId) this.deliveryLedger.complete(payload.deliveryId);
			}).catch((error) => {
				log.logWarning("Zulip webhook processing error", error instanceof Error ? error.message : String(error));
			});
		});
	}

	createWorkingOutputContext(
		target: WorkingOutputTarget,
		store: ChannelStore,
		options: WorkingOutputContextOptions,
	): MomContext {
		return createWorkspaceWorkingOutputContext(this.workspaceTransport(), target, store, options);
	}

	createContext(event: MomEvent, store: ChannelStore, isEvent?: boolean): MomContext {
		return createWorkspaceMessageContext(this.workspaceTransport(), event, store, {
			isEvent,
			responseThreadId: event.threadTs,
		});
	}

	private workspaceTransport(): WorkspaceChannelTransport {
		return {
			platform: "zulip",
			maxMessageLength: this.maxMessageLength,
			formatStatus: (text) => `*${text}*`,
			assertWorkingTarget: (target) => {
				if (target.platform !== "zulip") {
					throw new Error("Zulip working output requires a Zulip conversation target.");
				}
				this.requireKnownConversation(target.channelId);
			},
			postMessage: (channel, text) => this.postMessage(channel, text),
			updateMessage: (channel, id, text) => this.updateMessage(channel, id, text),
			deleteMessage: (channel, id) => this.deleteMessage(channel, id),
			postInThread: (channel, topic, text) => this.postInThread(channel, topic, text),
			uploadFile: (channel, filePath, title, topic) => this.uploadFile(channel, filePath, title, topic),
			logBotResponse: (channel, text, id, metadata) => this.logBotResponse(channel, text, id, metadata),
			getUser: (userId) => this.getUser(userId),
			getChannel: (channelId) => this.getChannel(channelId),
			getAllUsers: () => this.getAllUsers(),
			getAllChannels: () => this.getAllChannels(),
			describeReplyTarget: (channelId, topic) => this.describeReplyTarget(channelId, topic),
		};
	}

	private async handleMessage(message: ZulipMessage, awaitCompletion = false): Promise<void> {
		const isDirect = message.type === "private";
		const channel = isDirect
			? this.directChannelForMessage(message)
			: String(message.stream_id);
		if (isDirect) {
			this.observeDirectConversation(channel, message.display_recipient);
		} else {
			this.observeStream(channel, message.display_recipient);
		}

		const senderId = String(message.sender_id);
		const senderIsBot = message.sender_is_bot === true || senderId === this.botUserId;
		this.rememberUser({
			user_id: message.sender_id,
			email: message.sender_email,
			full_name: message.sender_full_name,
			is_bot: senderIsBot,
		});
		const rawText = message.raw_content ?? this.renderedContentToMarkdown(message.content);
		const text = isDirect ? rawText : stripZulipMentions(rawText);
		const ts = String(message.id);
		const topic = !isDirect && message.subject ? message.subject : undefined;
		const directlyAddressed = isDirect
			? !senderIsBot || isMentioned(message)
			: this.directChannelMessages || isMentioned(message);
		const sourceEventType = isDirect
			? "zulip_dm"
			: directlyAddressed
				? "zulip_mention"
				: "zulip_channel_message";
		const replyTarget = isDirect
			? `zulip:${channel}`
			: formatZulipTopicTarget(channel, topic || "");
		const replyTargetDescription = this.describeReplyTarget(channel, topic);
		await this.store.logMessage({
			date: new Date(message.timestamp * 1_000).toISOString(),
			ts,
			threadTs: topic,
			channel: `zulip:${this.channels.get(channel)?.name || channel}`,
			channelId: channel,
			user: senderId,
			userName: message.sender_email,
			displayName: message.sender_full_name,
			text,
			attachments: [],
			isBot: senderIsBot,
			directlyAddressed,
			sourceEventType,
		} as Parameters<ChannelStore["logMessage"]>[0]);
		if (senderIsBot && !directlyAddressed) return;
		this.pulse?.record(
			channel,
			senderId,
			text.length,
			text,
			this.pulseMetadata(channel, ts, directlyAddressed, topic),
		);
		if (senderId === this.botUserId) return;
		const event: MomEvent = {
			type: isDirect ? "dm" : "mention",
			channel,
			ts,
			user: senderId,
			text,
			rawText,
			attachments: [],
			sourceEventType,
			directlyAddressed,
			threadTs: topic,
			replyTarget,
			replyTargetDescription,
		};
		if (!directlyAddressed) {
			this.onAmbientMessage?.(channel, event, this);
			return;
		}
		await routeWorkspaceChannelEvent({
			handler: this.handler,
			adapter: this,
			event,
			queue: this.getQueue(channel),
			awaitCompletion,
		});
	}

	private acceptsDmFrom(userId: string): boolean {
		return this.allowedDmUserIds === undefined || this.allowedDmUserIds.has(userId);
	}

	private streamIsInScope(channelId: string): boolean {
		return isZulipChannelId(channelId)
			&& (this.allowedChannelIds === undefined || this.allowedChannelIds.has(channelId));
	}

	private observeStream(channelId: string, name: string): void {
		if (!this.streamIsInScope(channelId)) {
			throw new Error(`Zulip channel ${channelId} is outside this agent's configured scope`);
		}
		this.channels.set(channelId, { id: channelId, name: name || channelId });
	}

	private directChannelForMessage(message: ZulipDirectMessage): string {
		const participantIds = message.display_recipient
			.map((recipient) => String(recipient.id))
			.filter((userId) => userId !== this.botUserId);
		return formatZulipDmChannel(participantIds);
	}

	private observeDirectConversation(channel: string, recipients: ZulipDirectRecipient[]): void {
		const names: string[] = [];
		for (const recipient of recipients) {
			this.rememberUser({
				user_id: recipient.id,
				email: recipient.email,
				full_name: recipient.full_name,
				...(String(recipient.id) === this.botUserId ? { is_bot: true } : {}),
			});
			if (String(recipient.id) !== this.botUserId) names.push(recipient.full_name);
		}
		const prefix = names.length > 1 ? "Group DM" : "DM";
		this.channels.set(channel, { id: channel, name: `${prefix}: ${names.join(", ") || channel}` });
	}

	private restoreKnownDirectConversations(): void {
		try {
			for (const line of readFileSync(join(this.workingDir, "log.jsonl"), "utf8").split("\n")) {
				if (!line.trim()) continue;
				const entry = JSON.parse(line) as { channel?: unknown; channelId?: unknown };
				if (
					typeof entry.channel === "string"
					&& entry.channel.startsWith("zulip:")
					&& typeof entry.channelId === "string"
					&& parseZulipDmChannel(entry.channelId)
				) {
					this.channels.set(entry.channelId, {
						id: entry.channelId,
						name: entry.channel.slice("zulip:".length) || entry.channelId,
					});
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error("Zulip direct-message history is unreadable");
			}
		}
	}

	private renderedContentToMarkdown(content: string): string {
		return this.turndown.turndown(content || "").trim();
	}

	private describeReplyTarget(channel: string, topic?: string): string {
		if (parseZulipDmChannel(channel)) return "Zulip direct-message conversation";
		if (topic) return `Zulip channel topic ${topic}`;
		return "Zulip channel containing this message";
	}

	private rememberUser(user: ZulipUser): void {
		const userId = String(user.user_id);
		const existing = this.users.get(userId);
		this.users.set(userId, {
			id: userId,
			userName: user.email,
			displayName: user.full_name,
			isBot: user.is_bot === undefined ? existing?.isBot : user.is_bot === true,
		});
	}

	private pulseMetadata(
		channel: string,
		messageId: string,
		directlyAddressed: boolean,
		topic?: string,
	): PulseRecordMetadata {
		return {
			messageId,
			...(topic ? { threadTs: topic } : {}),
			replyTarget: parseZulipDmChannel(channel)
				? `zulip:${channel}`
				: formatZulipTopicTarget(channel, topic || ""),
			replyTargetDescription: this.describeReplyTarget(channel, topic),
			directlyAddressed,
		};
	}

	private requireKnownConversation(channel: string): void {
		if (parseZulipDmChannel(channel)) {
			if (!this.channels.has(channel)) throw new Error(`Unknown Zulip direct conversation ${channel}`);
			return;
		}
		this.requireKnownStream(channel);
	}

	private requireKnownStream(channel: string): string {
		if (!this.streamIsInScope(channel) || !this.channels.has(channel)) {
			throw new Error(`Zulip channel ${channel} is not a current known subscription`);
		}
		return channel;
	}

	private defaultTopic(channel: string): string {
		if (this.channelPolicies.get(channel) === "disable_empty_topic") {
			throw new Error(`Zulip channel ${channel} requires a topic target`);
		}
		return "";
	}

	private async sendMessageBody(body: URLSearchParams): Promise<string> {
		const result = await this.api<ZulipResponse>("/messages", { method: "POST", body });
		if (!Number.isInteger(result.id)) throw new Error("Zulip message response omitted the ID");
		return String(result.id);
	}

	private messageId(value: string): string {
		if (!/^[1-9]\d*$/.test(value)) throw new Error("Zulip message ID is invalid");
		return value;
	}

	private getQueue(channelId: string): WorkspaceChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new WorkspaceChannelQueue((error) => {
				log.logWarning("Zulip queue error", error instanceof Error ? error.message : String(error));
			});
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.botToken}`);
		const response = await fetch(`${this.apiBase}${path}`, { ...init, headers });
		const text = await response.text();
		let payload: unknown;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`Zulip host proxy returned invalid JSON (HTTP ${response.status})`);
		}
		if (!response.ok || (payload as { result?: string })?.result === "error") {
			const detail = typeof (payload as { msg?: unknown })?.msg === "string"
				? `: ${(payload as { msg: string }).msg}`
				: "";
			throw new Error(`Zulip host proxy returned HTTP ${response.status}${detail}`);
		}
		return payload as T;
	}
}

function isMentioned(message: ZulipMessage): boolean {
	return message.is_mentioned === true
		|| Boolean(message.flags?.includes("mentioned"))
		|| Boolean(message.flags?.includes("wildcard_mentioned"));
}

function stripZulipMentions(text: string): string {
	return text.replace(/@\*\*[^*\n]+\*\*/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

function matchesBearer(header: string | undefined, expected: string): boolean {
	const actual = Buffer.from(header?.replace(/^Bearer\s+/i, "") || "");
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
