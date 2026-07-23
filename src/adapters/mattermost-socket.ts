import { appendFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import WebSocket from "ws";
import { MomSettingsManager, type WorkingOutputTarget } from "../context.js";
import type { ChannelPulse, PulseRecordMetadata } from "../engagement/channel-pulse.js";
import * as log from "../log.js";
import type { Attachment, ChannelStore } from "../store.js";
import { createTwoMessageContext } from "./context.js";
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

interface MattermostUserResponse {
	id: string;
	username: string;
	first_name?: string;
	last_name?: string;
	nickname?: string;
	is_bot?: boolean;
}

interface MattermostChannelResponse {
	id: string;
	name: string;
	display_name?: string;
	type: "O" | "P" | "D" | "G" | string;
	team_id?: string;
}

interface MattermostTeamResponse {
	id: string;
	name: string;
}

interface MattermostPost {
	id: string;
	create_at: number;
	update_at?: number;
	delete_at?: number;
	user_id: string;
	channel_id: string;
	root_id?: string;
	message?: string;
	type?: string;
	props?: Record<string, unknown>;
	file_ids?: string[];
}

interface MattermostPostsResponse {
	order?: string[];
	posts?: Record<string, MattermostPost>;
}

interface MattermostFileInfo {
	id: string;
	name?: string;
}

interface MattermostWebSocketEvent {
	seq_reply?: number;
	status?: string;
	error?: { message?: string };
	event?: string;
	data?: Record<string, unknown>;
	broadcast?: { channel_id?: string; user_id?: string };
}

interface MattermostUser extends UserInfo {
	isBot?: boolean;
}

interface MattermostChannel extends ChannelInfo {
	type: string;
	teamId?: string;
}

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: Array<{ work: QueuedWork; resolve: () => void }> = [];
	private processing = false;

	enqueue(work: QueuedWork): Promise<void> {
		let resolve!: () => void;
		const done = new Promise<void>((doneResolve) => { resolve = doneResolve; });
		this.queue.push({ work, resolve });
		void this.processNext();
		return done;
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const item = this.queue.shift()!;
		try {
			await item.work();
		} catch (error) {
			log.logWarning("Mattermost queue error", error instanceof Error ? error.message : String(error));
		} finally {
			item.resolve();
			this.processing = false;
			void this.processNext();
		}
	}
}

export interface MattermostSocketConfig {
	url: string;
	botToken: string;
	workingDir: string;
	store: ChannelStore;
	pulse?: ChannelPulse;
	allowedChannelIds?: Iterable<string>;
	allowedDmUsers?: Iterable<string>;
	directChannelMessages?: boolean;
	onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
}

export class MattermostSocketAdapter implements PlatformAdapter {
	readonly name = "mattermost";
	readonly maxMessageLength = 16383;
	readonly formatInstructions = `## Mattermost Formatting (Markdown)
Use standard Markdown. Mattermost supports **bold**, _italic_, \`code\`, fenced code blocks, lists, and [links](https://example.com).
Mention users with @username.`;

	private readonly baseUrl: string;
	private readonly apiBase: string;
	private readonly websocketUrl: string;
	private readonly botToken: string;
	private readonly workingDir: string;
	private readonly store: ChannelStore;
	private readonly pulse?: ChannelPulse;
	private readonly allowedChannelIds?: ReadonlySet<string>;
	private readonly allowedDmUsers?: ReadonlySet<string>;
	private readonly directChannelMessages: boolean;
	private readonly onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
	private readonly users = new Map<string, MattermostUser>();
	private readonly channels = new Map<string, MattermostChannel>();
	private readonly queues = new Map<string, ChannelQueue>();
	private readonly seenPosts = new Map<string, number>();
	private handler!: MomHandler;
	private botUserId: string | null = null;
	private botUsername: string | null = null;
	private ws: WebSocket | null = null;
	private stopped = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelayMs = 1_000;

	constructor(config: MattermostSocketConfig) {
		const parsed = new URL(config.url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("Mattermost URL must use http:// or https://");
		}
		this.baseUrl = parsed.toString().replace(/\/$/, "");
		this.apiBase = `${this.baseUrl}/api/v4`;
		const websocketProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
		this.websocketUrl = `${websocketProtocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}/api/v4/websocket`;
		this.botToken = config.botToken;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.pulse = config.pulse;
		this.allowedChannelIds = config.allowedChannelIds === undefined
			? undefined
			: new Set(Array.from(config.allowedChannelIds, (entry) => entry.trim()).filter(Boolean));
		this.allowedDmUsers = config.allowedDmUsers === undefined
			? undefined
			: new Set(Array.from(config.allowedDmUsers, (entry) => entry.trim().toLowerCase()).filter(Boolean));
		this.directChannelMessages = config.directChannelMessages ?? false;
		this.onAmbientMessage = config.onAmbientMessage;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("MattermostSocketAdapter: handler not set");
		this.stopped = false;
		await this.initMetadata();
		await this.connect();
		log.logConnected();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		const ws = this.ws;
		this.ws = null;
		if (!ws || ws.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(forceClose);
				resolve();
			};
			const forceClose = setTimeout(() => {
				ws.terminate();
				finish();
			}, 1_000);
			forceClose.unref();
			ws.once("close", finish);
			try {
				if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
				else ws.close(1000, "shutdown");
			} catch {
				ws.terminate();
				finish();
			}
		});
	}

	getUser(userId: string): UserInfo | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		if (!this.acceptsChannel(channelId)) return undefined;
		return this.channels.get(channelId);
	}

	getAllUsers(): UserInfo[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): ChannelInfo[] {
		return Array.from(this.channels.values()).filter((channel) => this.acceptsChannel(channel.id));
	}

	async postMessage(
		channel: string,
		text: string,
		attachments: Array<{ filePath: string; filename: string }> = [],
	): Promise<string> {
		this.requireAllowedChannel(channel);
		const fileIds = await this.uploadFiles(channel, attachments);
		const post = await this.api<MattermostPost>("/posts", {
			method: "POST",
			body: JSON.stringify({
				channel_id: channel,
				message: text,
				...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
			}),
		});
		return post.id;
	}

	async updateMessage(channel: string, id: string, text: string): Promise<void> {
		this.requireAllowedChannel(channel);
		await this.api(`/posts/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify({ id, message: text }),
		});
	}

	async deleteMessage(channel: string, id: string): Promise<void> {
		this.requireAllowedChannel(channel);
		await this.api(`/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		this.requireAllowedChannel(channel);
		const post = await this.api<MattermostPost>("/posts", {
			method: "POST",
			body: JSON.stringify({ channel_id: channel, root_id: threadTs, message: text }),
		});
		return post.id;
	}

	async postResponseMessage(event: MomEvent, text: string): Promise<string> {
		return event.threadTs
			? this.postInThread(event.channel, event.threadTs, text)
			: this.postMessage(event.channel, text);
	}

	async uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void> {
		this.requireAllowedChannel(channel);
		const filename = title || basename(filePath);
		const fileIds = await this.uploadFiles(channel, [{ filePath, filename }]);
		if (fileIds.length === 0) throw new Error("Mattermost upload returned no file IDs");
		await this.api("/posts", {
			method: "POST",
			body: JSON.stringify({
				channel_id: channel,
				...(threadTs ? { root_id: threadTs } : {}),
				message: title || "",
				file_ids: fileIds,
			}),
		});
	}

	private async uploadFiles(
		channel: string,
		attachments: Array<{ filePath: string; filename: string }>,
	): Promise<string[]> {
		const fileIds: string[] = [];
		for (const attachment of attachments) {
			const form = new FormData();
			form.append("channel_id", channel);
			form.append("files", new Blob([readFileSync(attachment.filePath)]), attachment.filename);
			const upload = await this.api<{ file_infos?: MattermostFileInfo[] }>("/files", {
				method: "POST",
				body: form,
			});
			fileIds.push(...(upload.file_infos || []).map((file) => file.id).filter(Boolean));
		}
		return fileIds;
	}

	async readThread(channel: string, threadTs: string, limit = 40): Promise<ThreadTranscriptMessage[]> {
		this.requireAllowedChannel(channel);
		const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || 40, 100));
		const response = await this.api<MattermostPostsResponse>(`/posts/${encodeURIComponent(threadTs)}/thread?perPage=100`);
		const posts = response.posts || {};
		const order = (response.order || Object.keys(posts))
			.map((id) => posts[id])
			.filter((post): post is MattermostPost => Boolean(post && !post.delete_at))
			.sort((a, b) => a.create_at - b.create_at);
		const root = order.find((post) => post.id === threadTs);
		let visible = order.slice(-boundedLimit);
		if (root && !visible.some((post) => post.id === root.id)) {
			visible = boundedLimit === 1 ? [root] : [root, ...visible.slice(-(boundedLimit - 1))];
		}
		const channelName = this.channels.get(channel)?.name || channel;
		return Promise.all(visible.map(async (post) => {
			await this.ensureUser(post.user_id);
			const user = this.users.get(post.user_id);
			return {
				date: new Date(post.create_at).toISOString(),
				ts: post.id,
				threadTs,
				channelId: channel,
				channelName,
				sender: user?.displayName || user?.userName || post.user_id,
				text: post.message || "",
				isRoot: post.id === threadTs,
				isBot: Boolean(user?.isBot),
				sourceEventType: "mattermost_posts_thread",
			};
		}));
	}

	logBotResponse(channel: string, text: string, ts: string, metadata: { threadTs?: string } = {}): void {
		const channelInfo = this.channels.get(channel);
		const rootId = metadata.threadTs || ts;
		void this.store.logMessage({
			date: new Date().toISOString(),
			ts,
			threadTs: rootId,
			channel: `mattermost:${channelInfo?.name || channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		} as Parameters<ChannelStore["logMessage"]>[0]);
		if (this.pulse && this.botUserId) {
			this.pulse.record(channel, this.botUserId, text.length, text, this.pulseMetadata(channel, ts, metadata.threadTs));
		}
	}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	enqueueEvent(event: MomEvent): boolean {
		if (!/^[a-z0-9]{26}$/.test(event.channel) || !this.acceptsChannel(event.channel)) return false;
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Mattermost event queue full for ${event.channel}`, event.text.substring(0, 80));
			return false;
		}
		queue.enqueue(async () => { await this.handler.handleEvent(event, this, true); });
		return true;
	}

	createWorkingOutputContext(
		target: WorkingOutputTarget,
		_store: ChannelStore,
		options: WorkingOutputContextOptions,
	): MomContext {
		if (target.platform !== "mattermost" || !/^[a-z0-9]{26}$/.test(target.channelId)) {
			throw new Error("Mattermost working output requires a valid channel ID.");
		}
		this.requireAllowedChannel(target.channelId);
		const event: MomEvent = {
			type: "mention",
			channel: target.channelId,
			ts: `working-${Date.now()}`,
			user: "system",
			text: "",
			directlyAddressed: false,
			replyTarget: `mattermost:${target.channelId}`,
			replyTargetDescription: "Configured Mattermost working-output destination",
			attachments: [],
		};
		const context = createTwoMessageContext(
			{
				post: (channel, text) => this.postMessage(channel, text),
				update: (channel, id, text) => this.updateMessage(channel, id, text),
				delete: (channel, id) => this.deleteMessage(channel, id),
				formatStatus: (text) => `_${text}_`,
				throttleMs: 0,
				maxLength: this.maxMessageLength,
			},
			{
				headerLine: "",
				event,
				channels: this.getAllChannels(),
				users: this.getAllUsers(),
				channelName: this.channels.get(target.channelId)?.name,
				verbose: "messages-only",
				toolStreaming: options.toolStreaming,
				workingStreamPresentation: options.presentation,
				workingStreamWindowMs: options.windowMinutes * 60_000,
			},
		);
		return { ...context, workingReplyTarget: target.channelId };
	}

	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
		const user = this.users.get(event.user);
		const eventFilename = isEvent ? event.text.match(/^\[(?:EVENT|ATTENTION):([^:]+):/)?.[1] : undefined;
		const responseThreadTs = event.threadTs;
		const threadMessages: string[] = [];
		let workingMessageId: string | null = null;
		const post = (channel: string, text: string) => responseThreadTs
			? this.postInThread(channel, responseThreadTs, text)
			: this.postMessage(channel, text);

		return createTwoMessageContext(
			{
				post,
				update: (channel, id, text) => this.updateMessage(channel, id, text),
				delete: (channel, id) => this.deleteMessage(channel, id),
				formatStatus: (text) => `_${text}_`,
				throttleMs: 0,
				maxLength: this.maxMessageLength,
			},
			{
				headerLine: eventFilename ? `_Starting event: ${eventFilename}_` : "",
				event,
				user,
				channels: this.getAllChannels(),
				users: this.getAllUsers(),
				channelName: this.channels.get(event.channel)?.name,
				isEvent,
				// Mattermost is a strict messages-only surface: only explicit send_message
				// calls (plus forced runtime errors) may create user-visible output.
				verbose: "messages-only",
				toolStreaming: "off",
			},
			{
				onWorkingUpdate: (id) => { workingMessageId = id; },
				logBotResponse: (channel, text, id) => this.logBotResponse(channel, text, id, { threadTs: responseThreadTs }),
				respondInThread: async (text) => {
					const rootId = responseThreadTs || workingMessageId;
					if (!rootId) return;
					threadMessages.push(await this.postInThread(event.channel, rootId, text));
				},
				uploadFile: (filePath, title) => this.uploadFile(event.channel, filePath, title, responseThreadTs),
				deleteMessages: async (workingId, finalId) => {
					for (const id of threadMessages.splice(0).reverse()) {
						try { await this.deleteMessage(event.channel, id); } catch {}
					}
					if (workingId) await this.deleteMessage(event.channel, workingId);
					if (finalId) await this.deleteMessage(event.channel, finalId);
				},
			},
		);
	}

	private async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.botToken}`);
		if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
		const response = await fetch(`${this.apiBase}${path}`, { ...init, headers });
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 500);
			throw new Error(`Mattermost API ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
		}
		if (response.status === 204) return undefined as T;
		return await response.json() as T;
	}

	private async initMetadata(): Promise<void> {
		const me = await this.api<MattermostUserResponse>("/users/me");
		this.botUserId = me.id;
		this.botUsername = me.username;
		this.rememberUser(me);
		this.pulse?.setSelfId(me.id);

		if (this.allowedChannelIds === undefined) {
			for (let page = 0; page < 20; page++) {
				const users = await this.api<MattermostUserResponse[]>(`/users?page=${page}&per_page=200`);
				for (const user of users) this.rememberUser(user);
				if (users.length < 200) break;
			}
		}

		const teams = await this.api<MattermostTeamResponse[]>("/users/me/teams");
		for (const team of teams) {
			const channels = await this.api<MattermostChannelResponse[]>(`/users/me/teams/${encodeURIComponent(team.id)}/channels`);
			for (const channel of channels) this.rememberChannel(channel);
		}
		log.logInfo(`Loaded ${this.channels.size} Mattermost channels, ${this.users.size} users`);
	}

	private rememberUser(user: MattermostUserResponse): void {
		const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
		this.users.set(user.id, {
			id: user.id,
			userName: user.username,
			displayName: fullName || user.nickname || user.username,
			isBot: user.is_bot === true,
		});
	}

	private rememberChannel(channel: MattermostChannelResponse): void {
		if (!this.acceptsChannel(channel.id)) return;
		let name = channel.display_name || channel.name || channel.id;
		if (channel.type === "D" && this.botUserId) {
			const peerId = channel.name.split("__").find((id) => id !== this.botUserId);
			const peer = peerId ? this.users.get(peerId) : undefined;
			name = `DM:${peer?.displayName || peer?.userName || peerId || channel.id}`;
		}
		this.channels.set(channel.id, { id: channel.id, name, type: channel.type, teamId: channel.team_id });
	}

	private async ensureUser(userId: string): Promise<void> {
		if (!userId || this.users.has(userId)) return;
		try {
			this.rememberUser(await this.api<MattermostUserResponse>(`/users/${encodeURIComponent(userId)}`));
		} catch (error) {
			log.logWarning(`Failed to load Mattermost user ${userId}`, error instanceof Error ? error.message : String(error));
		}
	}

	private async ensureChannel(channelId: string): Promise<void> {
		if (!channelId || this.channels.has(channelId)) return;
		try {
			this.rememberChannel(await this.api<MattermostChannelResponse>(`/channels/${encodeURIComponent(channelId)}`));
		} catch (error) {
			log.logWarning(`Failed to load Mattermost channel ${channelId}`, error instanceof Error ? error.message : String(error));
		}
	}

	private connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.stopped) return reject(new Error("Mattermost adapter is stopped"));
			const ws = new WebSocket(this.websocketUrl);
			this.ws = ws;
			let authenticated = false;
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(error);
			};
			const timeout = setTimeout(() => {
				fail(new Error("Mattermost WebSocket authentication timed out"));
				ws.terminate();
			}, 10_000);

			ws.on("open", () => {
				ws.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: this.botToken } }));
			});
			ws.on("message", (raw) => {
				let event: MattermostWebSocketEvent;
				try {
					event = JSON.parse(raw.toString()) as MattermostWebSocketEvent;
				} catch {
					return;
				}
				if (event.seq_reply === 1) {
					if (event.status === "OK") {
						authenticated = true;
						settled = true;
						clearTimeout(timeout);
						this.reconnectDelayMs = 1_000;
						resolve();
					} else {
						fail(new Error(event.error?.message || "Mattermost WebSocket authentication failed"));
						ws.close();
					}
					return;
				}
				void this.handleWebSocketEvent(event);
			});
			ws.on("error", (error) => {
				if (!authenticated) {
					fail(error);
					ws.terminate();
				} else {
					log.logWarning("Mattermost WebSocket error", error.message);
				}
			});
			ws.on("close", () => {
				clearTimeout(timeout);
				if (this.ws === ws) this.ws = null;
				if (!authenticated) {
					fail(new Error("Mattermost WebSocket closed before authentication"));
					return;
				}
				if (!this.stopped) this.scheduleReconnect();
			});
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.stopped) return;
		const delay = this.reconnectDelayMs;
		this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
		log.logWarning(`Mattermost WebSocket disconnected; retrying in ${delay}ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect().catch((error) => {
				log.logWarning("Mattermost reconnect failed", error instanceof Error ? error.message : String(error));
				this.scheduleReconnect();
			});
		}, delay);
	}

	private async handleWebSocketEvent(event: MattermostWebSocketEvent): Promise<void> {
		if (event.event !== "posted") return;
		const rawPost = event.data?.post;
		if (typeof rawPost !== "string") return;
		let post: MattermostPost;
		try {
			post = JSON.parse(rawPost) as MattermostPost;
		} catch {
			return;
		}
		await this.handlePost(post);
	}

	private async handlePost(post: MattermostPost): Promise<void> {
		if (!post.id || !post.channel_id || !post.user_id || post.delete_at) return;
		if (!this.acceptsChannel(post.channel_id)) return;
		const prior = this.seenPosts.get(post.id);
		if (prior && Date.now() - prior < 10 * 60_000) return;
		this.seenPosts.set(post.id, Date.now());
		if (this.seenPosts.size > 1_000) {
			for (const [id, seenAt] of this.seenPosts) {
				if (Date.now() - seenAt > 10 * 60_000 || this.seenPosts.size > 900) this.seenPosts.delete(id);
			}
		}

		await Promise.all([this.ensureUser(post.user_id), this.ensureChannel(post.channel_id)]);
		const user = this.users.get(post.user_id);
		const channel = this.channels.get(post.channel_id);
		const text = post.message || "";
		const isDirectMessage = channel?.type === "D";
		const mentioned = this.botUsername ? new RegExp(`(^|\\s)@${escapeRegex(this.botUsername)}\\b`, "i").test(text) : false;
		const directlyAddressed = isDirectMessage || mentioned || this.directChannelMessages;
		const sourceEventType = isDirectMessage
			? "mattermost_dm"
			: mentioned
				? "mattermost_mention"
				: this.directChannelMessages
					? "mattermost_channel_direct"
					: "mattermost_posted";
		const rootId = post.root_id || post.id;
		const threadTs = isDirectMessage ? (post.root_id || undefined) : rootId;
		const replyTarget = `mattermost:${post.channel_id}:${rootId}`;
		const attachments = await this.processAttachments(post);
		const metadata = this.pulseMetadata(post.channel_id, post.id, threadTs, directlyAddressed);

		await this.store.logMessage({
			date: new Date(post.create_at || Date.now()).toISOString(),
			ts: post.id,
			threadTs: rootId,
			channel: `mattermost:${channel?.name || post.channel_id}`,
			channelId: post.channel_id,
			user: post.user_id,
			userName: user?.userName,
			displayName: user?.displayName,
			text,
			attachments,
			isBot: Boolean(user?.isBot),
			directlyAddressed,
			sourceEventType,
		} as Parameters<ChannelStore["logMessage"]>[0]);
		this.pulse?.record(post.channel_id, post.user_id, text.length, text, metadata);

		if (post.user_id === this.botUserId) return;
		const event: MomEvent = {
			type: isDirectMessage ? "dm" : "mention",
			channel: post.channel_id,
			ts: post.id,
			user: post.user_id,
			teamId: channel?.teamId,
			text,
			rawText: text,
			attachments,
			sourceEventType,
			directlyAddressed,
			threadTs,
			replyTarget,
			replyTargetDescription: "Mattermost thread containing this message",
		};

		if (isDirectMessage && !this.acceptsDmFrom(post.user_id)) {
			log.logWarning(`Ignoring Mattermost DM from unauthorized user ${post.user_id}`);
			return;
		}
		if (directlyAddressed) {
			if (this.handler.resolvePendingInput(post.channel_id, event.text)) return;
			if (await this.handler.handleSlashCommand(event, this)) return;
			if (event.text.toLowerCase().trim() === "stop") {
				await this.handler.handleStop(post.channel_id, this, event);
				return;
			}
			if (this.handler.isRunning(post.channel_id)) {
				this.handler.handleSteer(event, this);
			} else {
				this.getQueue(post.channel_id).enqueue(async () => { await this.handler.handleEvent(event, this); });
			}
		} else {
			const attention = new MomSettingsManager(this.workingDir)
				.getMattermostChannelAttention(post.channel_id);
			if (attention === "ambient") {
				this.onAmbientMessage?.(post.channel_id, event, this);
			}
		}
	}

	private acceptsDmFrom(userId: string): boolean {
		if (this.allowedDmUsers === undefined) return true;
		const username = this.users.get(userId)?.userName.toLowerCase();
		return this.allowedDmUsers.has(userId.toLowerCase()) || Boolean(username && this.allowedDmUsers.has(username));
	}

	private acceptsChannel(channelId: string): boolean {
		return this.allowedChannelIds === undefined || this.allowedChannelIds.has(channelId);
	}

	private requireAllowedChannel(channelId: string): void {
		if (!this.acceptsChannel(channelId)) {
			throw new Error(`Mattermost channel ${channelId} is outside this agent's allowed scope`);
		}
	}

	private async processAttachments(post: MattermostPost): Promise<Attachment[]> {
		if (!post.file_ids?.length) return [];
		const files = await Promise.all(post.file_ids.map(async (id) => {
			try {
				const info = await this.api<MattermostFileInfo>(`/files/${encodeURIComponent(id)}/info`);
				return {
					name: info.name || id,
					url_private_download: `${this.apiBase}/files/${encodeURIComponent(id)}`,
				};
			} catch (error) {
				log.logWarning(`Failed to load Mattermost file ${id}`, error instanceof Error ? error.message : String(error));
				return null;
			}
		}));
		return this.store.processAttachments(
			post.channel_id,
			files.filter((file): file is NonNullable<typeof file> => Boolean(file)),
			String((post.create_at || Date.now()) / 1000),
		);
	}

	private pulseMetadata(channel: string, messageId: string, threadTs?: string, directlyAddressed = false): PulseRecordMetadata {
		const rootId = threadTs || messageId;
		return {
			messageId,
			threadTs: rootId,
			replyTarget: `mattermost:${channel}:${rootId}`,
			replyTargetDescription: "Mattermost thread containing this message",
			directlyAddressed,
		};
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
