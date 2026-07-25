import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { WorkingOutputTarget } from "../context.js";
import type { ChannelPulse } from "../engagement/channel-pulse.js";
import * as log from "../log.js";
import type { Attachment, ChannelStore } from "../store.js";
import { withHostReceipt, type HostDeliveryReceipt } from "./host-receipt.js";
import type {
	ChannelInfo,
	MomContext,
	MomEvent,
	MomHandler,
	PlatformAdapter,
	ThreadTranscriptMessage,
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

interface RocketChatUser {
	_id: string;
	username?: string;
	name?: string;
}

interface RocketChatMessage {
	_id: string;
	rid: string;
	msg?: string;
	ts?: string;
	tmid?: string;
	t?: string;
	u: RocketChatUser;
	customFields?: {
		tinyfat?: {
			eventId?: string;
		};
	};
	file?: {
		_id?: string;
		name?: string;
		type?: string;
	};
	files?: Array<{
		_id?: string;
		name?: string;
		type?: string;
	}>;
}

interface RocketChatGroup {
	_id: string;
	name: string;
	fname?: string;
	t: string;
}

interface RocketChatMessageResponse {
	success: boolean;
	message: RocketChatMessage;
	duplicate?: boolean;
}

interface RocketChatHistoryResponse {
	success: boolean;
	messages: RocketChatMessage[];
}

interface RocketChatMeResponse extends RocketChatUser {
	success: boolean;
	roles?: string[];
}

export interface RocketChatWebhookConfig {
	url: string;
	botToken: string;
	inboundToken: string;
	agentName: string;
	workingDir: string;
	store: ChannelStore;
	allowedRoomIds: Iterable<string>;
	pulse?: ChannelPulse;
}

export class RocketChatWebhookAdapter implements PlatformAdapter {
	readonly name = "rocket-chat";
	readonly maxMessageLength = 5000;
	readonly formatInstructions = `## Rocket.Chat Formatting (Markdown)
Use standard Markdown. Mention operators with @username only when the message genuinely needs their attention.`;

	private readonly apiBase: string;
	private readonly botToken: string;
	private readonly inboundToken: string;
	private readonly agentName: string;
	private readonly workingDir: string;
	private readonly store: ChannelStore;
	private readonly pulse?: ChannelPulse;
	private readonly allowedRoomIds: ReadonlySet<string>;
	private readonly users = new Map<string, UserInfo>();
	private readonly channels = new Map<string, ChannelInfo>();
	private readonly queues = new Map<string, WorkspaceChannelQueue>();
	private readonly deliveryLedger: WorkspaceDeliveryLedger;
	private handler!: MomHandler;
	private botUserId: string | null = null;
	private botUsername: string | null = null;

	constructor(config: RocketChatWebhookConfig) {
		const parsed = new URL(config.url);
		if (!["http:", "https:"].includes(parsed.protocol)) {
			throw new Error("Rocket.Chat URL must use http:// or https://");
		}
		this.apiBase = `${parsed.toString().replace(/\/$/, "")}/api/v1`;
		this.botToken = config.botToken;
		this.inboundToken = config.inboundToken;
		this.agentName = config.agentName;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.pulse = config.pulse;
		this.allowedRoomIds = new Set(
			Array.from(config.allowedRoomIds, (roomId) => roomId.trim()).filter(Boolean),
		);
		if (this.allowedRoomIds.size === 0) {
			throw new Error("Rocket.Chat webhook adapter requires at least one allowed room");
		}
		this.deliveryLedger = new WorkspaceDeliveryLedger(
			join(this.workingDir, "rocket-chat-inbound-deliveries.jsonl"),
			"Rocket.Chat delivery ledger is unreadable",
		);
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("RocketChatWebhookAdapter: handler not set");
		const me = await this.api<RocketChatMeResponse>("/me");
		this.botUserId = me._id;
		this.botUsername = me.username || "agent";
		this.rememberUser({
			_id: me._id,
			username: me.username,
			name: me.name || this.agentName,
		});
		for (const roomId of this.allowedRoomIds) {
			const result = await this.api<{ success: boolean; group: RocketChatGroup }>(
				`/groups.info?roomId=${encodeURIComponent(roomId)}`,
			);
			if (result.group._id !== roomId || result.group.t !== "p") {
				throw new Error("Rocket.Chat host proxy returned an invalid private customer room");
			}
			this.channels.set(roomId, {
				id: roomId,
				name: result.group.fname || result.group.name || roomId,
			});
		}
		this.pulse?.setSelfId(me._id);
		log.logConnected();
	}

	async stop(): Promise<void> {}

	getUser(userId: string): UserInfo | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		return this.allowedRoomIds.has(channelId) ? this.channels.get(channelId) : undefined;
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
		return this.post(channel, text, undefined, attachments);
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		return this.post(channel, text, threadTs);
	}

	async postResponseMessage(event: MomEvent, text: string): Promise<string> {
		return this.postInThread(event.channel, event.threadTs || event.ts, text);
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		this.requireAllowedRoom(channel);
		await this.api("/chat.update", {
			method: "POST",
			body: JSON.stringify({ roomId: channel, msgId: ts, text }),
		});
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		this.requireAllowedRoom(channel);
		await this.api("/chat.delete", {
			method: "POST",
			body: JSON.stringify({ roomId: channel, msgId: ts }),
		});
	}

	async uploadFile(
		channel: string,
		filePath: string,
		title?: string,
		threadTs?: string,
	): Promise<void> {
		await this.uploadAttachment(
			channel,
			filePath,
			title || basename(filePath),
			title || "",
			threadTs,
		);
	}

	async readThread(channel: string, threadTs: string, limit = 40): Promise<ThreadTranscriptMessage[]> {
		this.requireAllowedRoom(channel);
		const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 40, 100));
		const result = await this.api<RocketChatHistoryResponse>(
			`/chat.getThreadMessages?tmid=${encodeURIComponent(threadTs)}&count=${boundedLimit}`,
		);
		return result.messages.map((message) => {
			this.rememberUser(message.u);
			return {
				date: message.ts,
				ts: message._id,
				threadTs,
				channelId: channel,
				channelName: this.channels.get(channel)?.name,
				sender: this.users.get(message.u._id)?.displayName || message.u._id,
				text: message.msg || "",
				isRoot: message._id === threadTs,
				isBot: Boolean(message.customFields?.tinyfat?.eventId),
				directlyAddressed: true,
				sourceEventType: "rocket_chat_thread",
			};
		});
	}

	logBotResponse(channel: string, text: string, ts: string, metadata: { threadTs?: string } = {}): void {
		const botUserId = this.botUserId || "tinyfat-agent";
		void this.store.logMessage({
			date: new Date().toISOString(),
			ts,
			threadTs: metadata.threadTs || ts,
			channel: `rocket-chat:${this.channels.get(channel)?.name || channel}`,
			channelId: channel,
			user: botUserId,
			userName: this.botUsername || "agent",
			displayName: this.agentName,
			text,
			attachments: [],
			isBot: true,
			directlyAddressed: true,
			sourceEventType: "rocket_chat_agent_message",
		} as Parameters<ChannelStore["logMessage"]>[0]);
	}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	enqueueEvent(event: MomEvent): boolean {
		if (!this.allowedRoomIds.has(event.channel)) return false;
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Rocket.Chat event queue full for ${event.channel}`, event.text.substring(0, 80));
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
				message?: RocketChatMessage;
				hostReceipt?: HostDeliveryReceipt;
			};
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof payload;
			} catch {
				response.writeHead(400);
				response.end("Invalid JSON");
				return;
			}
			if (!payload.message?._id || !payload.message.rid || !payload.message.u?._id) {
				response.writeHead(400);
				response.end("Missing Rocket.Chat message");
				return;
			}
			if (!this.allowedRoomIds.has(payload.message.rid)) {
				response.writeHead(403);
				response.end("Rocket.Chat room outside allowed scope");
				return;
			}
			response.writeHead(202, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, accepted: true }));
			void withHostReceipt(payload.hostReceipt, async () => {
				if (payload.deliveryId && this.deliveryLedger.has(payload.deliveryId)) return;
				await this.handleMessage(payload.message!, true);
				if (payload.deliveryId) this.deliveryLedger.complete(payload.deliveryId);
			}).catch((error) => {
				log.logWarning("Rocket.Chat webhook processing error", error instanceof Error ? error.message : String(error));
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
		const responseThreadTs = event.threadTs || event.ts;
		return createWorkspaceMessageContext(this.workspaceTransport(), event, store, {
			isEvent,
			responseThreadId: responseThreadTs,
		});
	}

	private workspaceTransport(): WorkspaceChannelTransport {
		return {
			platform: "rocket-chat",
			maxMessageLength: this.maxMessageLength,
			assertWorkingTarget: (target) => {
				if (target.platform !== "rocket-chat" || !/^[a-zA-Z0-9_-]{8,128}$/.test(target.channelId)) {
					throw new Error("Rocket.Chat working output requires a valid room ID.");
				}
				this.requireAllowedRoom(target.channelId);
			},
			postMessage: (channel, text) => this.postMessage(channel, text),
			updateMessage: (channel, id, text) => this.updateMessage(channel, id, text),
			deleteMessage: (channel, id) => this.deleteMessage(channel, id),
			postInThread: (channel, rootId, text) => this.postInThread(channel, rootId, text),
			uploadFile: (channel, filePath, title, rootId) => this.uploadFile(channel, filePath, title, rootId),
			logBotResponse: (channel, text, id, metadata) => this.logBotResponse(channel, text, id, metadata),
			getUser: (userId) => this.getUser(userId),
			getChannel: (channelId) => this.getChannel(channelId),
			getAllUsers: () => this.getAllUsers(),
			getAllChannels: () => this.getAllChannels(),
			describeReplyTarget: (_channelId, rootId) => rootId
				? "Rocket.Chat customer relationship thread containing this message"
				: "Configured Rocket.Chat working-output destination",
		};
	}

	private async post(
		channel: string,
		text: string,
		threadTs?: string,
		attachments: Array<{ filePath: string; filename: string }> = [],
	): Promise<string> {
		this.requireAllowedRoom(channel);
		if (attachments.length > 0) {
			let messageId = "";
			for (const [index, attachment] of attachments.entries()) {
				messageId = await this.uploadAttachment(
					channel,
					attachment.filePath,
					attachment.filename,
					index === 0 ? text : "",
					threadTs,
				);
			}
			return messageId;
		}
		const result = await this.api<RocketChatMessageResponse>("/chat.postMessage", {
			method: "POST",
			body: JSON.stringify({
				roomId: channel,
				text,
				...(threadTs ? { tmid: threadTs } : {}),
				tinyfatEventId: `rocket-chat:${randomUUID()}`,
			}),
		});
		return result.message._id;
	}

	private async uploadAttachment(
		channel: string,
		filePath: string,
		filename: string,
		text: string,
		threadTs?: string,
	): Promise<string> {
		this.requireAllowedRoom(channel);
		const form = new FormData();
		form.append("file", new Blob([readFileSync(filePath)]), filename);
		const uploaded = await this.api<{ success: boolean; file: { _id: string } }>(
			`/rooms.media/${encodeURIComponent(channel)}`,
			{ method: "POST", body: form },
		);
		if (!uploaded.file?._id) {
			throw new Error("Rocket.Chat file upload response omitted the file ID");
		}
		const eventId = `rocket-chat:${randomUUID()}`;
		const confirmed = await this.api<RocketChatMessageResponse>(
			`/rooms.mediaConfirm/${encodeURIComponent(channel)}/${encodeURIComponent(uploaded.file._id)}`,
			{
				method: "POST",
				body: JSON.stringify({
					msg: text,
					description: filename,
					...(threadTs ? { tmid: threadTs } : {}),
					customFields: {
						tinyfat: {
							schema: 1,
							kind: "collaboration.attachment.recorded",
							eventId,
							source: "rocket-chat",
							actorKind: "agent",
							visibility: "channel",
						},
					},
				}),
			},
		);
		if (!confirmed.message?._id) {
			throw new Error("Rocket.Chat file confirmation response omitted the message ID");
		}
		return confirmed.message._id;
	}

	private async handleMessage(message: RocketChatMessage, awaitCompletion = false): Promise<void> {
		if (message.t || message.customFields?.tinyfat?.eventId) return;
		this.requireAllowedRoom(message.rid);
		this.rememberUser(message.u);
		const text = message.msg || "";
		const rootId = message.tmid || message._id;
		const attachments = this.processAttachments(message);
		await this.store.logMessage({
			date: message.ts || new Date().toISOString(),
			ts: message._id,
			threadTs: rootId,
			channel: `rocket-chat:${this.channels.get(message.rid)?.name || message.rid}`,
			channelId: message.rid,
			user: message.u._id,
			userName: message.u.username,
			displayName: message.u.name || message.u.username,
			text,
			attachments,
			isBot: false,
			directlyAddressed: true,
			sourceEventType: "rocket_chat_room_message",
		} as Parameters<ChannelStore["logMessage"]>[0]);
		const event: MomEvent = {
			type: "mention",
			channel: message.rid,
			ts: message._id,
			user: message.u._id,
			text,
			rawText: text,
			attachments,
			sourceEventType: "rocket_chat_room_message",
			directlyAddressed: true,
			threadTs: rootId,
			replyTarget: `rocket-chat:${message.rid}:${rootId}`,
			replyTargetDescription: "Rocket.Chat customer relationship thread containing this message",
		};
		await routeWorkspaceChannelEvent({
			handler: this.handler,
			adapter: this,
			event,
			queue: this.getQueue(message.rid),
			awaitCompletion,
		});
	}

	private processAttachments(message: RocketChatMessage): Attachment[] {
		const files = [...(message.files || []), ...(message.file ? [message.file] : [])];
		const uniqueFiles = Array.from(
			new Map(
				files
					.filter((file) => file._id && file.name)
					.map((file) => [file._id!, file]),
			).values(),
		);
		if (uniqueFiles.length === 0) return [];
		const parsedTimestamp = message.ts ? Date.parse(message.ts) : Number.NaN;
		const timestampSeconds = String(
			Number.isFinite(parsedTimestamp) ? parsedTimestamp / 1_000 : Date.now() / 1_000,
		);
		return this.store.processAttachments(
			message.rid,
			uniqueFiles.map((file) => ({
				name: file.name,
				url_private_download: `${this.apiBase}/files/${encodeURIComponent(message._id)}/${encodeURIComponent(file._id!)}/${encodeURIComponent(file.name!)}`,
			})),
			timestampSeconds,
		);
	}

	private rememberUser(user: RocketChatUser): void {
		this.users.set(user._id, {
			id: user._id,
			userName: user.username || user._id,
			displayName: user.name || user.username || user._id,
		});
	}

	private requireAllowedRoom(roomId: string): void {
		if (!this.allowedRoomIds.has(roomId)) {
			throw new Error(`Rocket.Chat room ${roomId} is outside this agent's allowed scope`);
		}
	}

	private getQueue(roomId: string): WorkspaceChannelQueue {
		let queue = this.queues.get(roomId);
		if (!queue) {
			queue = new WorkspaceChannelQueue((error) => {
				log.logWarning("Rocket.Chat queue error", error instanceof Error ? error.message : String(error));
			});
			this.queues.set(roomId, queue);
		}
		return queue;
	}

	private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.botToken}`);
		if (typeof init.body === "string" && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/json");
		}
		const response = await fetch(`${this.apiBase}${path}`, { ...init, headers });
		const text = await response.text();
		let payload: unknown;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`Rocket.Chat host proxy returned invalid JSON (HTTP ${response.status})`);
		}
		if (!response.ok) {
			const detail = typeof (payload as { error?: unknown })?.error === "string"
				? `: ${(payload as { error: string }).error}`
				: "";
			throw new Error(`Rocket.Chat host proxy returned HTTP ${response.status}${detail}`);
		}
		return payload as T;
	}
}

function matchesBearer(header: string | undefined, expected: string): boolean {
	const actual = Buffer.from(header?.replace(/^Bearer\s+/i, "") || "");
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
