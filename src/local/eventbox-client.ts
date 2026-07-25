import { hostname } from "os";
import WebSocket from "ws";
import * as log from "../log.js";
import type { LocalTenantProfile } from "./tenant-profile.js";

const DEFAULT_POLICY = "observe";
const PING_INTERVAL_MS = 25_000;
const MAX_RECONNECT_MS = 30_000;
const MAX_PENDING_PUBLISHES = 50;
const MAX_SEEN_EVENTS = 500;

export interface LocalEventboxEvent {
	type: "event";
	seq?: number;
	event_id?: string;
	agent_id?: string;
	source_activation_id?: string;
	source_role?: string;
	kind: string;
	created_at?: string;
	payload?: Record<string, unknown>;
}

export interface LocalEventboxClient {
	activationId: string;
	start(): void;
	stop(): void;
	publish(kind: string, payload: Record<string, unknown>, options?: { eventId?: string; createdAt?: string }): void;
	onEvent(handler: (event: LocalEventboxEvent) => void): () => void;
}

interface LocalEventboxConfig {
	baseUrl: string;
	agentId: string;
	accessToken: string;
	activationId: string;
	deviceId: string;
	role: string;
	policy: string;
}

type PendingPublish = {
	kind: string;
	payload: Record<string, unknown>;
	eventId?: string;
	createdAt?: string;
};

class WebSocketLocalEventboxClient implements LocalEventboxClient {
	readonly activationId: string;

	private readonly config: LocalEventboxConfig;
	private readonly handlers = new Set<(event: LocalEventboxEvent) => void>();
	private readonly pending: PendingPublish[] = [];
	private readonly seenEvents: string[] = [];
	private readonly seenEventSet = new Set<string>();
	private ws: WebSocket | null = null;
	private stopped = true;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectDelayMs = 1000;

	constructor(config: LocalEventboxConfig) {
		this.config = config;
		this.activationId = config.activationId;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.clearTimers();
		this.ws?.close();
		this.ws = null;
	}

	publish(kind: string, payload: Record<string, unknown>, options: { eventId?: string; createdAt?: string } = {}): void {
		const pending = {
			kind,
			payload,
			eventId: options.eventId,
			createdAt: options.createdAt,
		};
		if (!this.sendPublish(pending)) {
			this.pending.push(pending);
			if (this.pending.length > MAX_PENDING_PUBLISHES) {
				this.pending.splice(0, this.pending.length - MAX_PENDING_PUBLISHES);
			}
		}
	}

	onEvent(handler: (event: LocalEventboxEvent) => void): () => void {
		this.handlers.add(handler);
		return () => {
			this.handlers.delete(handler);
		};
	}

	private connect(): void {
		if (this.stopped) return;
		const url = eventboxUrl(this.config);
		const ws = new WebSocket(url, {
			headers: {
				Authorization: `Bearer ${this.config.accessToken}`,
				"X-TinyFat-Activation-Id": this.config.activationId,
				"X-TinyFat-Eventbox-Role": this.config.role,
				"X-TinyFat-Eventbox-Policy": this.config.policy,
			},
		});
		this.ws = ws;

		ws.on("open", () => {
			this.reconnectDelayMs = 1000;
			log.logInfo(`[eventbox] connected agent=${this.config.agentId} activation=${this.config.activationId}`);
			this.sendRaw({
				type: "hello",
				activation_id: this.config.activationId,
				device_id: this.config.deviceId,
				role: this.config.role,
				policy: this.config.policy,
			});
			this.flushPending();
			this.startPing();
		});
		ws.on("message", (data) => this.handleMessage(data));
		ws.on("close", () => this.handleDisconnect());
		ws.on("error", (err) => {
			log.logWarning("[eventbox] socket error", err.message);
		});
	}

	private handleDisconnect(): void {
		this.clearTimers();
		if (this.stopped) return;
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		const delay = this.reconnectDelayMs;
		this.reconnectDelayMs = Math.min(MAX_RECONNECT_MS, Math.round(this.reconnectDelayMs * 1.8));
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private startPing(): void {
		this.pingTimer = setInterval(() => {
			this.sendRaw({ type: "ping", ts: new Date().toISOString() });
		}, PING_INTERVAL_MS);
	}

	private clearTimers(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.reconnectTimer = null;
		this.pingTimer = null;
	}

	private flushPending(): void {
		while (this.pending.length > 0) {
			const next = this.pending.shift();
			if (!next) continue;
			if (!this.sendPublish(next)) {
				this.pending.unshift(next);
				break;
			}
		}
	}

	private sendPublish(pending: PendingPublish): boolean {
		return this.sendRaw({
			type: "publish",
			kind: pending.kind,
			event_id: pending.eventId,
			created_at: pending.createdAt ?? new Date().toISOString(),
			payload: pending.payload,
		});
	}

	private sendRaw(message: Record<string, unknown>): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
		this.ws.send(JSON.stringify(message));
		return true;
	}

	private handleMessage(data: WebSocket.RawData): void {
		const message = parseMessage(data);
		if (!message || message.type !== "event") return;
		const event = message as unknown as LocalEventboxEvent;
		if (event.source_activation_id === this.config.activationId) return;
		const eventId = typeof event.event_id === "string" && event.event_id.trim()
			? event.event_id.trim()
			: `${event.kind}:${event.seq ?? ""}:${event.created_at ?? ""}`;
		if (this.seenEventSet.has(eventId)) return;
		this.rememberEvent(eventId);
		for (const handler of this.handlers) {
			try {
				handler(event);
			} catch (err) {
				log.logWarning("[eventbox] event handler failed", err instanceof Error ? err.message : String(err));
			}
		}
	}

	private rememberEvent(eventId: string): void {
		this.seenEventSet.add(eventId);
		this.seenEvents.push(eventId);
		if (this.seenEvents.length <= MAX_SEEN_EVENTS) return;
		const remove = this.seenEvents.splice(0, this.seenEvents.length - MAX_SEEN_EVENTS);
		for (const id of remove) this.seenEventSet.delete(id);
	}
}

export function createLocalEventboxClientFromEnv(
	options: { profile: LocalTenantProfile; env?: Record<string, string | undefined> },
): LocalEventboxClient | null {
	const env = options.env ?? process.env;
	const agentId = clean(env.TROUBLEMAKER_CLOUD_AGENT_ID) ?? options.profile.cloudAgentId;
	const baseUrl = clean(env.TROUBLEMAKER_CLOUD_BASE_URL) ?? options.profile.cloudBaseUrl;
	const accessToken = clean(env.TROUBLEMAKER_CLOUD_ACCESS_TOKEN);
	if (!agentId || !baseUrl || !accessToken) {
		const missing = [
			!agentId ? "TROUBLEMAKER_CLOUD_AGENT_ID" : "",
			!baseUrl ? "TROUBLEMAKER_CLOUD_BASE_URL" : "",
			!accessToken ? "TROUBLEMAKER_CLOUD_ACCESS_TOKEN" : "",
		].filter(Boolean).join(", ");
		log.logInfo(`[eventbox] disabled; missing ${missing}`);
		return null;
	}

	const deviceId = clean(env.TROUBLEMAKER_EVENTBOX_DEVICE_ID) ?? `mac:${hostname()}`;
	const activationId = clean(env.TROUBLEMAKER_EVENTBOX_ACTIVATION_ID) ?? `${deviceId}:${Date.now().toString(36)}`;
	return new WebSocketLocalEventboxClient({
		baseUrl,
		agentId,
		accessToken,
		activationId,
		deviceId,
		role: clean(env.TROUBLEMAKER_EVENTBOX_ROLE) ?? "mac-runtime",
		policy: clean(env.TROUBLEMAKER_EVENTBOX_POLICY) ?? DEFAULT_POLICY,
	});
}

function eventboxUrl(config: LocalEventboxConfig): string {
	const url = new URL(`/api/v2/agents/${config.agentId}/eventbox`, config.baseUrl);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	url.searchParams.set("activation_id", config.activationId);
	url.searchParams.set("device_id", config.deviceId);
	url.searchParams.set("role", config.role);
	url.searchParams.set("policy", config.policy);
	return url.toString();
}

function parseMessage(data: WebSocket.RawData): Record<string, unknown> | null {
	try {
		const text = typeof data === "string"
			? data
			: data instanceof Buffer
				? data.toString("utf-8")
				: Array.isArray(data)
					? Buffer.concat(data).toString("utf-8")
					: Buffer.from(new Uint8Array(data as ArrayBuffer)).toString("utf-8");
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}
