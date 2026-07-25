import WebSocket from "ws";
import * as log from "../log.js";
import {
	DiscordBase,
	type DiscordBaseConfig,
	type DiscordGatewayMessagePayload,
} from "./discord-base.js";
import { DEFAULT_DISCORD_GATEWAY_INTENTS } from "./discord-config.js";

const GATEWAY_VERSION = 10;
const MAX_GATEWAY_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_OUTBOUND_GATEWAY_BYTES = 4096;
const IDENTIFY_WINDOW_MS = 5000;
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NON_RESUMABLE_CLOSE_CODES = new Set([1000, 1001, 4003, 4005, 4007, 4009]);

interface DiscordGatewaySocket {
	readonly readyState: number;
	on(event: string, listener: (...args: any[]) => void): unknown;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
}

export interface DiscordGatewayTimerApi {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface DiscordGatewayDependencies {
	createWebSocket?: (url: string) => DiscordGatewaySocket;
	random?: () => number;
	timers?: DiscordGatewayTimerApi;
}

export interface DiscordGatewayAdapterConfig extends DiscordBaseConfig {
	/** Gateway intent bitfield. Defaults to guild/direct messages plus message content. */
	intents?: number;
	/** Non-mention guild messages are discarded unless explicitly enabled. */
	allowAmbientGuildMessages?: boolean;
	/** Run one shard in this process. Both values must be supplied together. */
	shardId?: number;
	shardCount?: number;
	reconnectBaseDelayMs?: number;
	reconnectMaxDelayMs?: number;
	startupTimeoutMs?: number;
	helloTimeoutMs?: number;
	/** @internal Deterministic WebSocket and clock hooks used by adapter tests. */
	dependencies?: DiscordGatewayDependencies;
}

interface GatewayBotResponse {
	url: string;
	shards: number;
	session_start_limit: {
		total: number;
		remaining: number;
		reset_after: number;
		max_concurrency: number;
	};
}

interface GatewayFrame {
	op: number;
	d?: unknown;
	s?: number | null;
	t?: string | null;
}

interface GatewaySession {
	id: string;
	resumeUrl: string;
}

export interface DiscordMessageCreate {
	id: string;
	channel_id: string;
	guild_id?: string;
	content: string;
	timestamp?: string;
	type?: number;
	webhook_id?: string;
	author: {
		id: string;
		username: string;
		global_name?: string | null;
		discriminator?: string;
		bot?: boolean;
		system?: boolean;
	};
	mentions?: Array<{ id: string }>;
	message_reference?: { message_id?: string };
	referenced_message?: {
		id?: string;
		author?: { id?: string; bot?: boolean };
	} | null;
	channel?: { name?: string };
}

export interface DiscordMessageClassificationOptions {
	botUserId: string;
	allowAmbientGuildMessages: boolean;
	isKnownBotMessage?: (messageId: string | undefined) => boolean;
}

/** Pure MESSAGE_CREATE classifier used by the Gateway adapter and deterministic tests. */
export function classifyDiscordMessageCreate(
	message: DiscordMessageCreate,
	options: DiscordMessageClassificationOptions,
): DiscordGatewayMessagePayload | null {
	if (!isMessageCreate(message)) return null;
	if (message.webhook_id || message.author.bot || message.author.system) return null;
	if (message.author.id === options.botUserId) return null;
	if (message.type !== undefined && message.type !== 0 && message.type !== 19) return null;
	if (!message.content.trim()) return null;

	const isDM = !message.guild_id;
	const isMentioned = Array.isArray(message.mentions)
		&& message.mentions.some((mention) => isRecord(mention) && mention.id === options.botUserId)
		|| message.content.includes(`<@${options.botUserId}>`)
		|| message.content.includes(`<@!${options.botUserId}>`);
	const referencedMessageId = message.message_reference?.message_id;
	const isReplyToBot = message.referenced_message?.author?.id === options.botUserId
		|| options.isKnownBotMessage?.(referencedMessageId) === true;

	let trigger: DiscordGatewayMessagePayload["trigger"];
	if (isDM) trigger = "dm";
	else if (isMentioned) trigger = "mention";
	else if (isReplyToBot) trigger = "reply";
	else if (options.allowAmbientGuildMessages) trigger = "ambient";
	else return null;

	return {
		type: "message",
		trigger,
		channelId: message.channel_id,
		channelName: message.channel?.name,
		guildId: message.guild_id ?? null,
		author: {
			id: message.author.id,
			username: message.author.username,
			global_name: message.author.global_name,
			discriminator: message.author.discriminator,
		},
		content: message.content,
		rawContent: message.content,
		messageId: message.id,
		isDM,
		isMentioned,
		timestamp: message.timestamp || "",
		botUserId: options.botUserId,
		referencedMessageId,
	};
}

export class DiscordGatewayAdapter extends DiscordBase {
	private readonly intents: number;
	private readonly allowAmbientGuildMessages: boolean;
	private readonly shardId?: number;
	private readonly shardCount?: number;
	private readonly reconnectBaseDelayMs: number;
	private readonly reconnectMaxDelayMs: number;
	private readonly startupTimeoutMs: number;
	private readonly helloTimeoutMs: number;
	private readonly createWebSocket: (url: string) => DiscordGatewaySocket;
	private readonly random: () => number;
	private readonly timers: DiscordGatewayTimerApi;

	private socket: DiscordGatewaySocket | null = null;
	private socketGeneration = 0;
	private connectionWantsResume = false;
	private authorizedGeneration = -1;
	private gatewayUrl: string | null = null;
	private recommendedShards = 1;
	private identifyRemaining = 0;
	private identifyResetAt = 0;
	private identifyMaxConcurrency = 1;
	private lastIdentifyAt = Number.NEGATIVE_INFINITY;
	private session: GatewaySession | null = null;
	private sequence: number | null = null;
	private heartbeatIntervalMs: number | null = null;
	private awaitingHeartbeatAck = false;
	private reconnectAttempt = 0;
	private started = false;
	private stopping = false;
	private fatal = false;

	private heartbeatTimer: unknown | null = null;
	private reconnectTimer: unknown | null = null;
	private helloTimer: unknown | null = null;
	private authorizationTimer: unknown | null = null;
	private startupTimer: unknown | null = null;
	private initialReadyPromise: Promise<void> | null = null;
	private resolveInitialReady: (() => void) | null = null;
	private rejectInitialReady: ((error: Error) => void) | null = null;

	constructor(config: DiscordGatewayAdapterConfig) {
		super(config);
		this.intents = validateInteger(config.intents, DEFAULT_DISCORD_GATEWAY_INTENTS, 0, Number.MAX_SAFE_INTEGER, "intents");
		this.allowAmbientGuildMessages = config.allowAmbientGuildMessages === true;
		this.shardId = config.shardId;
		this.shardCount = config.shardCount;
		validateShard(this.shardId, this.shardCount);
		this.reconnectBaseDelayMs = validateInteger(config.reconnectBaseDelayMs, 1000, 1, 60_000, "reconnectBaseDelayMs");
		this.reconnectMaxDelayMs = validateInteger(config.reconnectMaxDelayMs, 30_000, this.reconnectBaseDelayMs, 15 * 60_000, "reconnectMaxDelayMs");
		this.startupTimeoutMs = validateInteger(config.startupTimeoutMs, 30_000, 1, 5 * 60_000, "startupTimeoutMs");
		this.helloTimeoutMs = validateInteger(config.helloTimeoutMs, 15_000, 1, 60_000, "helloTimeoutMs");
		this.createWebSocket = config.dependencies?.createWebSocket ?? ((url) => new WebSocket(url, {
			handshakeTimeout: this.helloTimeoutMs,
			maxPayload: MAX_GATEWAY_FRAME_BYTES,
			perMessageDeflate: false,
		}) as unknown as DiscordGatewaySocket);
		this.random = config.dependencies?.random ?? Math.random;
		this.timers = config.dependencies?.timers ?? realTimers;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("DiscordGatewayAdapter: handler not set. Call setHandler() before start().");
		if (this.started) return;

		this.started = true;
		this.stopping = false;
		this.fatal = false;
		try {
			await this.discoverGateway();
			if (this.identifyRemaining <= 0) {
				const resetInMs = Math.max(0, this.identifyResetAt - this.timers.now());
				throw new Error(`Discord Gateway session start limit is exhausted; retry after approximately ${Math.ceil(resetInMs / 1000)} seconds`);
			}

			this.initialReadyPromise = new Promise<void>((resolve, reject) => {
				this.resolveInitialReady = resolve;
				this.rejectInitialReady = reject;
			});
			this.startupTimer = this.timers.setTimeout(() => {
				this.failPermanently(new Error("Discord Gateway did not become ready before the startup timeout"));
			}, this.startupTimeoutMs);

			this.connectNow(false);
			await this.initialReadyPromise;
			log.logConnected();
		} catch (error) {
			await this.stop();
			throw error;
		} finally {
			this.clearTimer("startupTimer");
			this.initialReadyPromise = null;
			this.resolveInitialReady = null;
			this.rejectInitialReady = null;
		}
	}

	async stop(): Promise<void> {
		if (!this.started && !this.socket) return;
		this.stopping = true;
		this.started = false;
		this.clearAllTimers();
		this.clearSession();
		this.socketGeneration++;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			if (socket.readyState === WebSocket.OPEN) {
				await new Promise<void>((resolve) => {
					let settled = false;
					const finish = () => {
						if (settled) return;
						settled = true;
						this.timers.clearTimeout(timeout);
						resolve();
					};
					const timeout = this.timers.setTimeout(() => {
						try { socket.terminate(); } catch { /* best effort */ }
						finish();
					}, 2000);
					socket.on("close", finish);
					try { socket.close(1000, "shutdown"); } catch {
						try { socket.terminate(); } catch { /* best effort */ }
						finish();
					}
				});
			} else if (socket.readyState === WebSocket.CONNECTING) {
				try { socket.terminate(); } catch { /* best effort */ }
			}
		}
		this.rejectInitialReady?.(new Error("Discord Gateway stopped before becoming ready"));
	}

	private async discoverGateway(): Promise<void> {
		const response = await this.discordFetch("/gateway/bot");
		if (!response.ok) throw new Error(`Discord Gateway discovery failed with HTTP ${response.status}`);

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new Error("Discord Gateway discovery returned invalid JSON");
		}
		if (!isGatewayBotResponse(payload)) throw new Error("Discord Gateway discovery returned an invalid response");
		validateGatewayUrl(payload.url);

		this.gatewayUrl = payload.url;
		this.recommendedShards = payload.shards;
		this.identifyRemaining = payload.session_start_limit.remaining;
		this.identifyResetAt = this.timers.now() + payload.session_start_limit.reset_after;
		this.identifyMaxConcurrency = payload.session_start_limit.max_concurrency;

		if (this.recommendedShards > 1 && this.shardId === undefined) {
			throw new Error(`Discord recommends ${this.recommendedShards} shards; configure one shard id/count per process instead of starting with partial coverage`);
		}
		if (this.shardCount !== undefined && this.shardCount < this.recommendedShards) {
			throw new Error(`Configured Discord shard count ${this.shardCount} is below the recommended count ${this.recommendedShards}`);
		}

		log.logInfo(`[discord] Gateway discovery ready (shards=${payload.shards}, identify remaining=${this.identifyRemaining}/${payload.session_start_limit.total}, max concurrency=${this.identifyMaxConcurrency})`);
	}

	private connectNow(preferResume: boolean): void {
		if (this.stopping || this.fatal || !this.gatewayUrl) return;
		this.clearTimer("reconnectTimer");
		const wantsResume = preferResume && this.canResume();
		const baseUrl = wantsResume ? this.session!.resumeUrl : this.gatewayUrl;
		let url: string;
		try {
			url = buildGatewayUrl(baseUrl);
		} catch (error) {
			this.failPermanently(error instanceof Error ? error : new Error("Invalid Discord Gateway URL"));
			return;
		}

		const generation = ++this.socketGeneration;
		this.connectionWantsResume = wantsResume;
		this.authorizedGeneration = -1;
		this.heartbeatIntervalMs = null;
		this.awaitingHeartbeatAck = false;
		let socket: DiscordGatewaySocket;
		try {
			socket = this.createWebSocket(url);
		} catch (error) {
			log.logWarning(`[discord] Gateway socket construction failed (${error instanceof Error ? error.name : "unknown error"})`);
			this.scheduleReconnect(wantsResume);
			return;
		}
		this.socket = socket;

		this.helloTimer = this.timers.setTimeout(() => {
			if (!this.isCurrentSocket(socket, generation)) return;
			log.logWarning("[discord] Gateway Hello timeout; reconnecting");
			this.requestReconnect(this.canResume());
		}, this.helloTimeoutMs);

		socket.on("open", () => {
			if (this.isCurrentSocket(socket, generation)) log.logInfo("[discord] Gateway socket opened; awaiting Hello");
		});
		socket.on("message", (data: unknown) => {
			if (!this.isCurrentSocket(socket, generation)) return;
			void this.handleRawFrame(data, socket, generation).catch((error) => {
				log.logWarning("[discord] Gateway frame handler failed", error instanceof Error ? error.message : String(error));
			});
		});
		socket.on("error", (error: unknown) => {
			if (!this.isCurrentSocket(socket, generation)) return;
			log.logWarning(`[discord] Gateway socket error (${error instanceof Error ? error.name : "unknown error"}); reconnecting`);
			this.requestReconnect(this.canResume());
		});
		socket.on("close", (code: number) => {
			if (!this.isCurrentSocket(socket, generation)) return;
			this.socket = null;
			this.clearConnectionTimers();
			if (this.stopping || this.fatal) return;

			if (FATAL_CLOSE_CODES.has(code)) {
				this.failPermanently(new Error(`Discord Gateway closed with non-reconnectable code ${code}`));
				return;
			}
			const resumable = !NON_RESUMABLE_CLOSE_CODES.has(code) && this.canResume();
			if (!resumable) this.clearSession();
			log.logWarning(`[discord] Gateway closed with code ${code}; scheduling ${resumable ? "resume" : "identify"}`);
			this.scheduleReconnect(resumable);
		});
	}

	private async handleRawFrame(data: unknown, socket: DiscordGatewaySocket, generation: number): Promise<void> {
		const text = decodeGatewayFrame(data);
		if (text === null) {
			log.logWarning("[discord] Ignoring malformed or oversized Gateway frame");
			return;
		}

		let frame: unknown;
		try {
			frame = JSON.parse(text);
		} catch {
			log.logWarning("[discord] Ignoring non-JSON Gateway frame");
			return;
		}
		if (!isGatewayFrame(frame)) {
			log.logWarning("[discord] Ignoring malformed Gateway payload");
			return;
		}
		if (typeof frame.s === "number") this.sequence = frame.s;

		switch (frame.op) {
			case 0:
				await this.handleDispatch(frame.t, frame.d);
				break;
			case 1:
				this.sendHeartbeat();
				break;
			case 7:
				log.logInfo("[discord] Gateway requested reconnect");
				this.requestReconnect(this.canResume(), 0);
				break;
			case 9: {
				const resumable = frame.d === true && this.canResume();
				if (!resumable) this.clearSession();
				const protocolDelay = 1000 + Math.floor(this.clampedRandom() * 4000);
				log.logWarning(`[discord] Gateway invalid session; scheduling ${resumable ? "resume" : "identify"}`);
				this.requestReconnect(resumable, Math.max(protocolDelay, this.nextBackoffDelay()));
				break;
			}
			case 10:
				this.handleHello(frame.d, socket, generation);
				break;
			case 11:
				this.awaitingHeartbeatAck = false;
				break;
			default:
				// Unknown receive opcodes are forward-compatible and safe to ignore.
				break;
		}
	}

	private handleHello(data: unknown, socket: DiscordGatewaySocket, generation: number): void {
		if (!isRecord(data) || !Number.isFinite(data.heartbeat_interval)) {
			log.logWarning("[discord] Ignoring malformed Gateway Hello");
			return;
		}
		const interval = Number(data.heartbeat_interval);
		if (interval < 100 || interval > 5 * 60_000) {
			log.logWarning("[discord] Gateway Hello contained an unsafe heartbeat interval");
			this.requestReconnect(this.canResume());
			return;
		}
		if (this.authorizedGeneration === generation) return;

		this.clearTimer("helloTimer");
		this.heartbeatIntervalMs = interval;
		this.scheduleHeartbeat(Math.floor(interval * this.clampedRandom()));
		this.authorizedGeneration = generation;
		if (this.connectionWantsResume && this.canResume()) {
			this.sendGatewayPayload({
				op: 6,
				d: { token: this.botToken, session_id: this.session!.id, seq: this.sequence },
			});
			return;
		}
		this.scheduleIdentify(socket, generation);
	}

	private scheduleIdentify(socket: DiscordGatewaySocket, generation: number): void {
		const now = this.timers.now();
		if (this.identifyRemaining <= 0) {
			if (now >= this.identifyResetAt) {
				void this.refreshDiscoveryAndIdentify(socket, generation);
				return;
			}
			const resetDelay = Math.max(1000, this.identifyResetAt - now);
			log.logWarning(`[discord] Identify session limit exhausted; reconnecting after reset in ${Math.ceil(resetDelay / 1000)}s`);
			this.requestReconnect(false, resetDelay);
			return;
		}

		const concurrencyDelay = Math.max(0, IDENTIFY_WINDOW_MS - (now - this.lastIdentifyAt));
		this.authorizationTimer = this.timers.setTimeout(() => {
			this.authorizationTimer = null;
			if (!this.isCurrentSocket(socket, generation)) return;
			this.lastIdentifyAt = this.timers.now();
			this.identifyRemaining--;
			const shard = this.shardId !== undefined && this.shardCount !== undefined
				? [this.shardId, this.shardCount]
				: undefined;
			this.sendGatewayPayload({
				op: 2,
				d: {
					token: this.botToken,
					intents: this.intents,
					properties: {
						os: process.platform,
						browser: "troublemaker",
						device: "troublemaker",
					},
					...(shard ? { shard } : {}),
				},
			});
		}, concurrencyDelay);
	}

	private async refreshDiscoveryAndIdentify(socket: DiscordGatewaySocket, generation: number): Promise<void> {
		try {
			await this.discoverGateway();
			if (this.isCurrentSocket(socket, generation)) this.scheduleIdentify(socket, generation);
		} catch (error) {
			log.logWarning(`[discord] Gateway rediscovery failed (${error instanceof Error ? error.name : "unknown error"})`);
			if (this.isCurrentSocket(socket, generation)) this.requestReconnect(false);
		}
	}

	private async handleDispatch(type: string | null | undefined, data: unknown): Promise<void> {
		switch (type) {
			case "READY": {
				if (!isReadyDispatch(data)) {
					log.logWarning("[discord] READY dispatch was malformed; reconnecting without resume");
					this.requestReconnect(false);
					return;
				}
				try {
					validateGatewayUrl(data.resume_gateway_url);
				} catch {
					log.logWarning("[discord] READY dispatch contained an invalid resume URL; reconnecting without resume");
					this.requestReconnect(false);
					return;
				}
				this.session = { id: data.session_id, resumeUrl: data.resume_gateway_url };
				this.setDiscordBotUserId(data.user.id);
				this.markConnectionEstablished("identified");
				break;
			}
			case "RESUMED":
				this.markConnectionEstablished("resumed");
				break;
			case "MESSAGE_CREATE":
				await this.handleMessageCreate(data);
				break;
			case "GUILD_CREATE":
				this.observeGuildChannels(data);
				break;
			case "CHANNEL_CREATE":
			case "CHANNEL_UPDATE":
				this.observeChannelDispatch(data);
				break;
			case "CHANNEL_DELETE":
				if (isRecord(data) && typeof data.id === "string") this.forgetDiscordChannel(data.id);
				break;
			default:
				break;
		}
	}

	private async handleMessageCreate(data: unknown): Promise<void> {
		if (!isMessageCreate(data) || !this.botUserId) {
			log.logWarning("[discord] Ignoring malformed MESSAGE_CREATE dispatch");
			return;
		}
		const message = classifyDiscordMessageCreate(data, {
			botUserId: this.botUserId,
			allowAmbientGuildMessages: this.allowAmbientGuildMessages,
			isKnownBotMessage: (messageId) => this.isKnownBotMessage(messageId),
		});
		if (!message) return;
		message.channelName = this.getChannel(message.channelId)?.name || message.channelName;
		await this.handleGatewayMessage(message);
	}

	private observeGuildChannels(data: unknown): void {
		if (!isRecord(data) || typeof data.id !== "string" || !this.acceptsDiscordGuild(data.id)) return;
		for (const candidate of [...asArray(data.channels), ...asArray(data.threads)]) {
			if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
			if (!this.acceptsDiscordChannel(candidate.id)) continue;
			this.observeDiscordChannel(candidate.id, typeof candidate.name === "string" ? candidate.name : undefined);
		}
	}

	private observeChannelDispatch(data: unknown): void {
		if (!isRecord(data) || typeof data.id !== "string" || !this.acceptsDiscordChannel(data.id)) return;
		if (typeof data.guild_id === "string" && !this.acceptsDiscordGuild(data.guild_id)) return;
		// DM metadata is learned from accepted messages so DM user boundaries remain fail-closed.
		if (data.guild_id === undefined) return;
		this.observeDiscordChannel(data.id, typeof data.name === "string" ? data.name : undefined);
	}

	private markConnectionEstablished(mode: "identified" | "resumed"): void {
		this.reconnectAttempt = 0;
		this.resolveInitialReady?.();
		log.logInfo(`[discord] Gateway session ${mode}`);
	}

	private sendHeartbeat(): void {
		if (this.awaitingHeartbeatAck) {
			log.logWarning("[discord] Gateway heartbeat ACK missing; reconnecting to resume");
			this.requestReconnect(this.canResume());
			return;
		}
		if (!this.sendGatewayPayload({ op: 1, d: this.sequence })) return;
		this.awaitingHeartbeatAck = true;
		if (this.heartbeatIntervalMs !== null) this.scheduleHeartbeat(this.heartbeatIntervalMs);
	}

	private scheduleHeartbeat(delayMs: number): void {
		this.clearTimer("heartbeatTimer");
		this.heartbeatTimer = this.timers.setTimeout(() => {
			this.heartbeatTimer = null;
			this.sendHeartbeat();
		}, delayMs);
	}

	private sendGatewayPayload(payload: object): boolean {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		const serialized = JSON.stringify(payload);
		if (Buffer.byteLength(serialized) > MAX_OUTBOUND_GATEWAY_BYTES) {
			this.failPermanently(new Error("Discord Gateway outbound payload exceeded 4096 bytes"));
			return false;
		}
		try {
			socket.send(serialized);
			return true;
		} catch (error) {
			log.logWarning(`[discord] Gateway send failed (${error instanceof Error ? error.name : "unknown error"}); reconnecting`);
			this.requestReconnect(this.canResume());
			return false;
		}
	}

	private requestReconnect(resume: boolean, delayMs?: number): void {
		if (this.stopping || this.fatal) return;
		if (!resume) this.clearSession();
		const socket = this.socket;
		this.socket = null;
		this.socketGeneration++;
		this.clearConnectionTimers();
		if (socket) {
			try { socket.terminate(); } catch { /* best effort */ }
		}
		this.scheduleReconnect(resume && this.canResume(), delayMs);
	}

	private scheduleReconnect(resume: boolean, delayMs?: number): void {
		if (this.stopping || this.fatal || this.reconnectTimer !== null) return;
		const boundedDelay = Math.max(0, Math.min(delayMs ?? this.nextBackoffDelay(), 0x7fffffff));
		this.reconnectTimer = this.timers.setTimeout(() => {
			this.reconnectTimer = null;
			this.connectNow(resume);
		}, boundedDelay);
	}

	private nextBackoffDelay(): number {
		const exponent = Math.min(this.reconnectAttempt++, 16);
		const cap = Math.min(this.reconnectMaxDelayMs, this.reconnectBaseDelayMs * (2 ** exponent));
		return Math.floor(cap * (0.5 + this.clampedRandom() * 0.5));
	}

	private failPermanently(error: Error): void {
		if (this.fatal) return;
		this.fatal = true;
		this.clearAllTimers();
		const socket = this.socket;
		this.socket = null;
		this.socketGeneration++;
		if (socket) {
			try { socket.terminate(); } catch { /* best effort */ }
		}
		log.logWarning(`[discord] Gateway stopped: ${error.message}`);
		this.rejectInitialReady?.(error);
	}

	private canResume(): boolean {
		return this.session !== null && this.sequence !== null;
	}

	private clearSession(): void {
		this.session = null;
		this.sequence = null;
		this.connectionWantsResume = false;
	}

	private isCurrentSocket(socket: DiscordGatewaySocket, generation: number): boolean {
		return !this.stopping && this.socket === socket && this.socketGeneration === generation;
	}

	private clearConnectionTimers(): void {
		this.clearTimer("heartbeatTimer");
		this.clearTimer("helloTimer");
		this.clearTimer("authorizationTimer");
		this.heartbeatIntervalMs = null;
		this.awaitingHeartbeatAck = false;
	}

	private clearAllTimers(): void {
		this.clearConnectionTimers();
		this.clearTimer("reconnectTimer");
		this.clearTimer("startupTimer");
	}

	private clearTimer(name: "heartbeatTimer" | "reconnectTimer" | "helloTimer" | "authorizationTimer" | "startupTimer"): void {
		const handle = this[name];
		if (handle !== null) this.timers.clearTimeout(handle);
		this[name] = null;
	}

	private clampedRandom(): number {
		const value = this.random();
		if (!Number.isFinite(value)) return 0.5;
		return Math.min(1, Math.max(0, value));
	}
}

const realTimers: DiscordGatewayTimerApi = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function validateInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
		throw new Error(`Discord Gateway ${name} must be an integer between ${min} and ${max}`);
	}
	return resolved;
}

function validateShard(shardId: number | undefined, shardCount: number | undefined): void {
	if ((shardId === undefined) !== (shardCount === undefined)) {
		throw new Error("Discord Gateway shardId and shardCount must be configured together");
	}
	if (shardId === undefined || shardCount === undefined) return;
	if (!Number.isSafeInteger(shardId) || !Number.isSafeInteger(shardCount) || shardId < 0 || shardCount < 1 || shardId >= shardCount) {
		throw new Error("Discord Gateway shard configuration is invalid");
	}
}

function validateGatewayUrl(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Discord Gateway URL is invalid");
	}
	if (url.protocol !== "wss:" || (url.hostname !== "gateway.discord.gg" && !url.hostname.endsWith(".discord.gg"))) {
		throw new Error("Discord Gateway URL must use a Discord wss endpoint");
	}
}

function buildGatewayUrl(base: string): string {
	validateGatewayUrl(base);
	const url = new URL(base);
	url.searchParams.set("v", String(GATEWAY_VERSION));
	url.searchParams.set("encoding", "json");
	url.searchParams.delete("compress");
	return url.toString();
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isGatewayFrame(value: unknown): value is GatewayFrame {
	if (!isRecord(value) || !Number.isInteger(value.op)) return false;
	if (value.s !== undefined && value.s !== null && (!Number.isSafeInteger(value.s) || value.s < 0)) return false;
	if (value.t !== undefined && value.t !== null && typeof value.t !== "string") return false;
	return true;
}

function isGatewayBotResponse(value: unknown): value is GatewayBotResponse {
	if (!isRecord(value) || typeof value.url !== "string") return false;
	if (!Number.isSafeInteger(value.shards) || value.shards < 1) return false;
	const limit = value.session_start_limit;
	return isRecord(limit)
		&& Number.isSafeInteger(limit.total) && limit.total >= 0
		&& Number.isSafeInteger(limit.remaining) && limit.remaining >= 0
		&& Number.isSafeInteger(limit.reset_after) && limit.reset_after >= 0
		&& Number.isSafeInteger(limit.max_concurrency) && limit.max_concurrency >= 1;
}

function isReadyDispatch(value: unknown): value is {
	session_id: string;
	resume_gateway_url: string;
	user: { id: string };
} {
	return isRecord(value)
		&& typeof value.session_id === "string" && !!value.session_id
		&& typeof value.resume_gateway_url === "string" && !!value.resume_gateway_url
		&& isRecord(value.user)
		&& typeof value.user.id === "string" && !!value.user.id;
}

function isMessageCreate(value: unknown): value is DiscordMessageCreate {
	if (!isRecord(value)
		|| typeof value.id !== "string" || !value.id
		|| typeof value.channel_id !== "string" || !value.channel_id
		|| typeof value.content !== "string"
		|| !isRecord(value.author)
		|| typeof value.author.id !== "string" || !value.author.id
		|| typeof value.author.username !== "string" || !value.author.username) return false;
	if (value.guild_id !== undefined && typeof value.guild_id !== "string") return false;
	if (value.timestamp !== undefined && typeof value.timestamp !== "string") return false;
	if (value.type !== undefined && !Number.isSafeInteger(value.type)) return false;
	if (value.webhook_id !== undefined && typeof value.webhook_id !== "string") return false;
	if (value.author.global_name !== undefined && value.author.global_name !== null && typeof value.author.global_name !== "string") return false;
	if (value.author.discriminator !== undefined && typeof value.author.discriminator !== "string") return false;
	if (value.author.bot !== undefined && typeof value.author.bot !== "boolean") return false;
	if (value.author.system !== undefined && typeof value.author.system !== "boolean") return false;
	if (value.mentions !== undefined
		&& (!Array.isArray(value.mentions)
			|| value.mentions.some((mention) => !isRecord(mention) || typeof mention.id !== "string"))) return false;
	if (value.message_reference !== undefined
		&& (!isRecord(value.message_reference)
			|| (value.message_reference.message_id !== undefined && typeof value.message_reference.message_id !== "string"))) return false;
	if (value.referenced_message !== undefined && value.referenced_message !== null) {
		if (!isRecord(value.referenced_message)) return false;
		if (value.referenced_message.id !== undefined && typeof value.referenced_message.id !== "string") return false;
		if (value.referenced_message.author !== undefined) {
			if (!isRecord(value.referenced_message.author)) return false;
			if (value.referenced_message.author.id !== undefined && typeof value.referenced_message.author.id !== "string") return false;
			if (value.referenced_message.author.bot !== undefined && typeof value.referenced_message.author.bot !== "boolean") return false;
		}
	}
	if (value.channel !== undefined
		&& (!isRecord(value.channel) || (value.channel.name !== undefined && typeof value.channel.name !== "string"))) return false;
	return true;
}

function decodeGatewayFrame(data: unknown): string | null {
	if (typeof data === "string") {
		return Buffer.byteLength(data) <= MAX_GATEWAY_FRAME_BYTES ? data : null;
	}
	if (Buffer.isBuffer(data)) {
		return data.byteLength <= MAX_GATEWAY_FRAME_BYTES ? data.toString("utf8") : null;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength <= MAX_GATEWAY_FRAME_BYTES ? Buffer.from(data).toString("utf8") : null;
	}
	if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
		const size = data.reduce((total, part) => total + part.byteLength, 0);
		return size <= MAX_GATEWAY_FRAME_BYTES ? Buffer.concat(data).toString("utf8") : null;
	}
	return null;
}
