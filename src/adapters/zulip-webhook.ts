import { timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
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

interface ZulipMessage {
	id: number;
	type: "stream";
	stream_id: number;
	display_recipient: string;
	subject: string;
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
	allowedChannelIds: Iterable<string>;
	pulse?: ChannelPulse;
	directChannelMessages?: boolean;
	onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
}

/**
 * Host-managed, topic-free Zulip transport for one customer-scoped runtime.
 *
 * The configured URL is a Hostd capability proxy, not the native Zulip URL.
 * Hostd owns provider credentials and constrains every operation to the one
 * channel bound to this runtime context.
 */
export class ZulipWebhookAdapter implements PlatformAdapter {
	readonly name = "zulip";
	readonly maxMessageLength = 10_000;
	readonly formatInstructions = `## Zulip Formatting (Markdown)
Use standard Markdown. This customer feed is topic-free, so send messages directly to the configured Zulip channel.`;

	private readonly apiBase: string;
	private readonly botToken: string;
	private readonly inboundToken: string;
	private readonly agentName: string;
	private readonly workingDir: string;
	private readonly store: ChannelStore;
	private readonly pulse?: ChannelPulse;
	private readonly allowedChannelIds: ReadonlySet<string>;
	private readonly directChannelMessages: boolean;
	private readonly onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
	private readonly users = new Map<string, ZulipKnownUser>();
	private readonly channels = new Map<string, ChannelInfo>();
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
		this.allowedChannelIds = new Set(
			Array.from(config.allowedChannelIds, (channelId) => channelId.trim()).filter(Boolean),
		);
		if (this.allowedChannelIds.size === 0) {
			throw new Error("Zulip webhook adapter requires at least one allowed channel");
		}
		for (const channelId of this.allowedChannelIds) {
			if (!/^[1-9]\d*$/.test(channelId)) {
				throw new Error("Zulip allowed channel IDs must be positive integers");
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
		for (const channelId of this.allowedChannelIds) {
			const stream = result.streams.find((candidate) => String(candidate.stream_id) === channelId);
			if (!stream) {
				throw new Error(`Zulip host proxy omitted allowed channel ${channelId}`);
			}
			if (stream.topics_policy !== "empty_topic_only") {
				throw new Error(`Zulip channel ${channelId} must use the topic-free policy`);
			}
			this.channels.set(channelId, { id: channelId, name: stream.name });
		}
		this.pulse?.setSelfId(this.botUserId);
		log.logConnected();
	}

	async stop(): Promise<void> {}

	getUser(userId: string): UserInfo | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		return this.allowedChannelIds.has(channelId) ? this.channels.get(channelId) : undefined;
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
		this.requireAllowedChannel(channel);
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
		const body = new URLSearchParams({
			type: "channel",
			to: channel,
			topic: "",
			content,
		});
		const result = await this.api<ZulipResponse>("/messages", { method: "POST", body });
		if (!Number.isInteger(result.id)) throw new Error("Zulip message response omitted the ID");
		return String(result.id);
	}

	async postInThread(channel: string, _threadTs: string, text: string): Promise<string> {
		return this.postMessage(channel, text);
	}

	async postResponseMessage(event: MomEvent, text: string): Promise<string> {
		return this.postMessage(event.channel, text);
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		this.requireAllowedChannel(channel);
		await this.api(`/messages/${this.messageId(ts)}`, {
			method: "PATCH",
			body: new URLSearchParams({ content: text }),
		});
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		this.requireAllowedChannel(channel);
		await this.api(`/messages/${this.messageId(ts)}`, { method: "DELETE" });
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		await this.postMessage(channel, "", [{
			filePath,
			filename: title || basename(filePath),
		}]);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		void this.store.logMessage({
			date: new Date().toISOString(),
			ts,
			threadTs: ts,
			channel: `zulip:${this.channels.get(channel)?.name || channel}`,
			channelId: channel,
			user: this.botUserId || "tinyfat-agent",
			userName: this.botEmail || "agent",
			displayName: this.agentName,
			text,
			attachments: [],
			isBot: true,
			directlyAddressed: true,
			sourceEventType: "zulip_agent_message",
		} as Parameters<ChannelStore["logMessage"]>[0]);
		if (this.pulse && this.botUserId) {
			this.pulse.record(channel, this.botUserId, text.length, text, this.pulseMetadata(channel, ts, true));
		}
	}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	enqueueEvent(event: MomEvent): boolean {
		if (!this.allowedChannelIds.has(event.channel)) return false;
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
				|| !Number.isInteger(message.stream_id)
				|| !Number.isInteger(message.sender_id)
				|| message.type !== "stream"
			) {
				response.writeHead(400);
				response.end("Missing Zulip message");
				return;
			}
			if (!this.allowedChannelIds.has(String(message.stream_id))) {
				response.writeHead(403);
				response.end("Zulip message outside topic-free customer scope");
				return;
			}
			response.writeHead(202, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, accepted: true }));
			void withHostReceipt(payload.hostReceipt, async () => {
				if (payload.deliveryId && this.deliveryLedger.has(payload.deliveryId)) return;
				await this.handleMessage(message);
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
		return createWorkspaceMessageContext(this.workspaceTransport(), event, store, { isEvent });
	}

	private workspaceTransport(): WorkspaceChannelTransport {
		return {
			platform: "zulip",
			maxMessageLength: this.maxMessageLength,
			formatStatus: (text) => `*${text}*`,
			assertWorkingTarget: (target) => {
				if (target.platform !== "zulip" || !/^[1-9]\d*$/.test(target.channelId)) {
					throw new Error("Zulip working output requires a valid channel ID.");
				}
				this.requireAllowedChannel(target.channelId);
			},
			postMessage: (channel, text) => this.postMessage(channel, text),
			updateMessage: (channel, id, text) => this.updateMessage(channel, id, text),
			deleteMessage: (channel, id) => this.deleteMessage(channel, id),
			postInThread: (channel, _rootId, text) => this.postMessage(channel, text),
			uploadFile: (channel, filePath, title) => this.uploadFile(channel, filePath, title),
			logBotResponse: (channel, text, id) => this.logBotResponse(channel, text, id),
			getUser: (userId) => this.getUser(userId),
			getChannel: (channelId) => this.getChannel(channelId),
			getAllUsers: () => this.getAllUsers(),
			getAllChannels: () => this.getAllChannels(),
			describeReplyTarget: () => "Topic-free Zulip customer exchange feed",
		};
	}

	private async handleMessage(message: ZulipMessage): Promise<void> {
		const channel = String(message.stream_id);
		this.requireAllowedChannel(channel);
		const senderId = String(message.sender_id);
		const senderIsBot = message.sender_is_bot === true || senderId === this.botUserId;
		const user: ZulipUser = {
			user_id: message.sender_id,
			email: message.sender_email,
			full_name: message.sender_full_name,
			is_bot: senderIsBot,
		};
		this.rememberUser(user);
		const text = message.raw_content ?? message.content;
		const ts = String(message.id);
		const directlyAddressed = this.directChannelMessages || isMentioned(message);
		const sourceEventType = directlyAddressed ? "zulip_mention" : "zulip_channel_message";
		await this.store.logMessage({
			date: new Date(message.timestamp * 1_000).toISOString(),
			ts,
			channel: `zulip:${this.channels.get(channel)?.name || message.display_recipient || channel}`,
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
		if (senderIsBot) return;
		this.pulse?.record(
			channel,
			senderId,
			text.length,
			text,
			this.pulseMetadata(channel, ts, directlyAddressed),
		);
		if (senderId === this.botUserId) return;
		const event: MomEvent = {
			type: "mention",
			channel,
			ts,
			user: senderId,
			text,
			rawText: text,
			attachments: [],
			sourceEventType,
			directlyAddressed,
			replyTarget: `zulip:${channel}`,
			replyTargetDescription: "Topic-free Zulip channel containing this message",
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
		});
	}

	private rememberUser(user: ZulipUser): void {
		this.users.set(String(user.user_id), {
			id: String(user.user_id),
			userName: user.email,
			displayName: user.full_name,
			isBot: user.is_bot === true,
		});
	}

	private pulseMetadata(
		channel: string,
		messageId: string,
		directlyAddressed: boolean,
	): PulseRecordMetadata {
		return {
			messageId,
			replyTarget: `zulip:${channel}`,
			replyTargetDescription: "Topic-free Zulip channel containing this message",
			directlyAddressed,
		};
	}

	private requireAllowedChannel(channelId: string): void {
		if (!this.allowedChannelIds.has(channelId)) {
			throw new Error(`Zulip channel ${channelId} is outside this agent's allowed scope`);
		}
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

function matchesBearer(header: string | undefined, expected: string): boolean {
	const actual = Buffer.from(header?.replace(/^Bearer\s+/i, "") || "");
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
