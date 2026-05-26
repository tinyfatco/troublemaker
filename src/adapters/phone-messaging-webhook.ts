import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { createHash } from "crypto";
import { join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";
import { createPhoneProviderRegistryFromEnv, type PhoneProviderRegistry } from "./phone-messaging/registry.js";
import type { PhoneChannelRecord, PhoneInboundPayload, PhoneOutboundAttachment, PhoneTransport } from "./phone-messaging/types.js";

interface ChannelRegistryFile {
	version: 1;
	channels: Record<string, PhoneChannelRecord>;
}

export interface PhoneMessagingWebhookAdapterConfig {
	workingDir: string;
	registry?: PhoneProviderRegistry;
}

export class PhoneMessagingWebhookAdapter implements PlatformAdapter {
	readonly name = "phone";
	readonly maxMessageLength = 1600;
	readonly formatInstructions = `## Phone Messaging Formatting
You are replying in an SMS/iMessage-style conversation. Keep messages concise, direct, and useful. Avoid long markdown tables and large code blocks unless explicitly requested. Loop/iMessage is for two-way conversations only: do not treat this as a cold outbound or broadcast channel. If no user-facing reply is needed, send no final response.`;

	private workingDir: string;
	private handler!: MomHandler;
	private registry: PhoneProviderRegistry;
	private channels = new Map<string, PhoneChannelRecord>();
	private users = new Map<string, UserInfo>();

	constructor(config: PhoneMessagingWebhookAdapterConfig) {
		this.workingDir = config.workingDir;
		this.registry = config.registry || createPhoneProviderRegistryFromEnv();
		this.loadChannelRegistry();
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("PhoneMessagingWebhookAdapter: handler not set. Call setHandler() before start().");
		log.logInfo(`[phone] adapter ready; providers=${this.registry.available().join(", ") || "none"}`);
		log.logConnected();
	}

	async stop(): Promise<void> {
		// Gateway owns the HTTP server.
	}

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const body = Buffer.concat(chunks).toString("utf-8");
			let payload: PhoneInboundPayload;
			try {
				payload = JSON.parse(body) as PhoneInboundPayload;
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			const missing = validatePayload(payload);
			if (missing) {
				res.writeHead(400);
				res.end(`Missing required field: ${missing}`);
				return;
			}

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));

			try {
				await this.processInbound(payload);
			} catch (err) {
				log.logWarning("[phone] inbound processing error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	private async processInbound(payload: PhoneInboundPayload): Promise<void> {
		if (payload.direction && payload.direction !== "inbound") {
			this.logReceipt(payload);
			return;
		}

		const record = this.upsertChannel(payload);
		const ts = payload.timestamp || new Date().toISOString();
		const userId = normalizeAddress(payload.from);
		const userName = userId;
		this.users.set(userId, { id: userId, userName, displayName: userId });

		const attachmentLines = (payload.attachments || [])
			.map((a) => `- ${a.filename || a.url || "attachment"}${a.url ? `: ${a.url}` : ""}`)
			.join("\n");
		const text = attachmentLines ? `${payload.text}\n\nAttachments:\n${attachmentLines}` : payload.text;

		const event: MomEvent = {
			type: "dm",
			channel: record.channelId,
			ts,
			user: userId,
			text,
			rawText: text,
			sourceEventType: "phone_message",
			directlyAddressed: true,
			replyTarget: record.channelId,
			replyTargetDescription: `${(record.transport || "phone").toUpperCase()} conversation with ${record.displayName}`,
		};

		this.logToFile({
			date: toIsoDate(ts),
			ts,
			channel: `phone:${record.displayName}`,
			channelId: record.channelId,
			user: userId,
			userName,
			displayName: userId,
			text,
			attachments: [],
			isBot: false,
			provider: payload.provider,
			transport: record.transport,
			providerMessageId: payload.messageId,
		});

		if (this.handler.resolvePendingInput(record.channelId, text)) return;
		if (await this.handler.handleSlashCommand(event, this)) return;

		if (text.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(record.channelId)) {
				this.handler.handleStop(record.channelId, this);
			} else {
				await this.postMessage(record.channelId, "Nothing running.");
			}
			return;
		}

		if (this.handler.isRunning(record.channelId)) {
			this.handler.handleSteer(event, this);
		} else {
			await this.handler.handleEvent(event, this);
		}
	}

	async postMessage(channel: string, text: string, attachments?: PhoneOutboundAttachment[]): Promise<string> {
		const record = this.resolveChannel(channel);
		const preferred = readPreferredTransport();
		const provider = this.registry.select(record, preferred);
		const result = await provider.sendMessage({ channel: record, text, attachments, preferredTransport: preferred });
		record.lastMessageId = result.providerMessageId;
		record.transport = result.transport || record.transport;
		record.updatedAt = new Date().toISOString();
		this.channels.set(record.channelId, record);
		this.saveChannelRegistry();
		return result.providerMessageId;
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {
		// Phone transports generally cannot edit messages.
	}

	async deleteMessage(_channel: string, _ts: string): Promise<void> {
		// Phone transports generally cannot delete messages for recipients.
	}

	async postInThread(channel: string, _threadTs: string, text: string): Promise<string> {
		return this.postMessage(channel, text);
	}

	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {
		throw new Error("Phone messaging uploadFile is not available yet. Send a public URL in the message instead.");
	}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		const record = this.resolveChannel(channel);
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `phone:${record.displayName}`,
			channelId: record.channelId,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
			provider: record.provider,
			transport: record.transport,
			providerMessageId: ts,
		});
	}

	private logReceipt(payload: PhoneInboundPayload): void {
		const record = this.upsertChannel(payload);
		const ts = payload.timestamp || new Date().toISOString();
		this.logToFile({
			date: toIsoDate(ts),
			ts,
			channel: `phone:${record.displayName}`,
			channelId: record.channelId,
			user: "provider",
			userName: payload.provider,
			displayName: `${payload.provider} receipt`,
			text: payload.text,
			attachments: [],
			isBot: true,
			provider: payload.provider,
			transport: record.transport,
			providerMessageId: payload.messageId,
			direction: payload.direction,
			status: payload.status,
		});
	}

	getUser(userId: string): UserInfo | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		const record = this.channels.get(channelId);
		return record ? { id: record.channelId, name: record.displayName } : undefined;
	}

	getAllUsers(): UserInfo[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): ChannelInfo[] {
		return Array.from(this.channels.values()).map((c) => ({ id: c.channelId, name: c.displayName }));
	}

	enqueueEvent(event: MomEvent): boolean {
		if (!event.channel.startsWith("phone-")) return false;
		this.handler.handleEvent(event, this, true).catch((err) => {
			log.logWarning(`[phone] event handler error for ${event.channel}`, err instanceof Error ? err.message : String(err));
		});
		return true;
	}

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		let finalText = "";
		let forceFinalResponse = false;
		return {
			message: {
				text: event.text,
				rawText: event.rawText ?? event.text,
				user: event.user,
				userName: event.user,
				channel: event.channel,
				ts: event.ts,
				eventType: event.type,
				sourceEventType: event.sourceEventType,
				directlyAddressed: event.directlyAddressed,
				threadTs: event.threadTs,
				replyTarget: event.replyTarget,
				replyTargetDescription: event.replyTargetDescription,
				attachments: [],
			},
			channelName: this.channels.get(event.channel)?.displayName,
			channels: this.getAllChannels(),
			users: this.getAllUsers(),
			respond: async () => {
				// Phone messaging is a send_message-only surface; suppress harness text.
			},
			sendFinalResponse: async (text: string, options = {}) => {
				const force = (options as { force?: boolean }).force === true;
				forceFinalResponse = force;
				finalText = force ? text : "";
			},
			respondInThread: async () => {
				// Suppress tool chatter in SMS/iMessage.
			},
			setTyping: async () => {
				// TODO: Loop supports typing indicators; keep provider-neutral for now.
			},
			uploadFile: async (filePath: string, title?: string) => {
				throw new Error(`Phone messaging cannot upload local file ${title || filePath} yet; use a public URL.`);
			},
			setWorking: async (working: boolean) => {
				if (!working && forceFinalResponse && finalText.trim()) {
					const ts = await this.postMessage(event.channel, finalText.trim());
					this.logBotResponse(event.channel, finalText.trim(), ts);
				}
			},
			deleteMessage: async () => {
				// No-op.
			},
			restartWorking: async () => {
				finalText = "";
			},
		};
	}

	private upsertChannel(payload: PhoneInboundPayload): PhoneChannelRecord {
		const sender = normalizeAddress(payload.sender || payload.to || "unknown-sender");
		const from = normalizeAddress(payload.from);
		const participants = Array.from(new Set([from, sender, ...(payload.recipients || []).map(normalizeAddress)].filter(Boolean))).sort();
		const conversationId = payload.conversationId || participants.join("|");
		const channelId = `phone-${createHash("sha256").update(`${payload.provider}:${sender}:${conversationId}`).digest("hex").slice(0, 20)}`;
		const transport = payload.transport || "unknown";
		const displayName = `${transport}/${from}`;
		const record: PhoneChannelRecord = {
			...(this.channels.get(channelId) || {} as PhoneChannelRecord),
			channelId,
			provider: payload.provider,
			transport,
			conversationId,
			from,
			sender,
			participants,
			displayName,
			lastMessageId: payload.messageId,
			updatedAt: new Date().toISOString(),
			providerData: payload.providerData,
		};
		this.channels.set(channelId, record);
		this.saveChannelRegistry();
		return record;
	}

	private resolveChannel(channel: string): PhoneChannelRecord {
		const record = this.channels.get(channel);
		if (record) return record;
		this.loadChannelRegistry();
		const reloaded = this.channels.get(channel);
		if (reloaded) return reloaded;
		throw new Error(`Unknown phone messaging channel: ${channel}. Ask the user to send a message first or use list_channels.`);
	}

	private registryPath(): string {
		return join(this.workingDir, "phone-channels.json");
	}

	private loadChannelRegistry(): void {
		const path = this.registryPath();
		if (!existsSync(path)) return;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as ChannelRegistryFile;
			for (const record of Object.values(raw.channels || {})) {
				this.channels.set(record.channelId, record);
			}
		} catch (err) {
			log.logWarning("[phone] failed to load phone-channels.json", err instanceof Error ? err.message : String(err));
		}
	}

	private saveChannelRegistry(): void {
		if (!existsSync(this.workingDir)) mkdirSync(this.workingDir, { recursive: true });
		const payload: ChannelRegistryFile = { version: 1, channels: Object.fromEntries(this.channels) };
		writeFileSync(this.registryPath(), `${JSON.stringify(payload, null, 2)}\n`);
	}
}

function validatePayload(payload: PhoneInboundPayload): string | null {
	if (!payload.provider) return "provider";
	if (!payload.messageId) return "messageId";
	if (!payload.from) return "from";
	if (payload.text == null) return "text";
	return null;
}

function normalizeAddress(value: string): string {
	return value.trim().toLowerCase();
}

function toIsoDate(value: string): string {
	const numeric = Number(value);
	if (!Number.isNaN(numeric)) {
		return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function readPreferredTransport(): PhoneTransport | "auto" | undefined {
	const value = (process.env.MOM_PHONE_PREFERRED_TRANSPORT || "auto").toLowerCase();
	if (["auto", "imessage", "sms", "mms", "rcs", "whatsapp", "unknown"].includes(value)) {
		return value as PhoneTransport | "auto";
	}
	return "auto";
}
