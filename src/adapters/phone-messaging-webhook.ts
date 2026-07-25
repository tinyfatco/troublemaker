import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { createHash } from "crypto";
import { join } from "path";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";
import { withHostReceipt } from "./host-receipt.js";
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
You are replying in a direct phone conversation. Keep messages concise, direct, and useful. Avoid long markdown tables and large code blocks unless explicitly requested. Phone messaging is for established two-way conversations only: do not treat this as cold outbound or broadcast. If no user-facing reply is needed, send no message.`;

	private workingDir: string;
	private handler!: MomHandler;
	private registry: PhoneProviderRegistry;
	private channels = new Map<string, PhoneChannelRecord>();
	private users = new Map<string, UserInfo>();
	private completedDeliveryIds?: Set<string>;

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
		if (!isAuthorizedVpsIngress(req)) {
			res.writeHead(401);
			res.end("Unauthorized");
			return;
		}

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
			const configuredHostManaged = process.env.MOM_PHONE_HOST_MANAGED === "true";
			if (Boolean(payload.hostManaged) !== configuredHostManaged) {
				res.writeHead(400);
				res.end("Phone delivery mode mismatch");
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
				if (payload.hostManaged) {
					await withHostReceipt(payload.hostReceipt, async () => {
						if (payload.deliveryId && this.isCompletedDelivery(payload.deliveryId)) return;
						await this.processInbound(payload);
						if (payload.deliveryId) this.markDeliveryCompleted(payload.deliveryId);
					});
				} else {
					await this.processInbound(payload);
				}
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
		const userId = payload.hostManaged ? record.displayName : normalizeAddress(payload.from);
		const userName = userId;
		this.users.set(userId, { id: userId, userName, displayName: userId });

		const attachmentLines = (payload.attachments || [])
			.map((a) => `- ${a.filename || a.url || "attachment"}${a.url ? `: ${a.url}` : ""}`)
			.join("\n");
		const text = attachmentLines ? `${payload.text}\n\nAttachments:\n${attachmentLines}` : payload.text;

		const recipientDescription = record.outboundRecipients && record.outboundRecipients.length > 1
			? `group with ${record.outboundRecipients.join(", ")}`
			: `conversation with ${record.displayName}`;
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
			replyTargetDescription: `${(record.transport || "phone").toUpperCase()} ${recipientDescription}`,
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
			await this.handler.handleSteer(event, this);
		} else {
			await this.handler.handleEvent(event, this);
		}
	}

	async postMessage(channel: string, text: string, attachments?: PhoneOutboundAttachment[]): Promise<string> {
		const record = this.resolveChannel(channel);
		return this.sendFromRecord(record, text, attachments);
	}

	async postMessageToRecipients(channel: string, text: string, recipients: string[], attachments?: PhoneOutboundAttachment[]): Promise<string> {
		const record = this.resolveChannel(channel);
		if (record.hostManaged) {
			throw new Error("Host-managed phone channels are direct-only; recipient selection is host-owned");
		}
		const outboundRecipients = outboundRecipientsForGroup(record.from, record.sender, recipients, record.outboundRecipients || []);
		const groupRecord: PhoneChannelRecord = {
			...record,
			transport: outboundRecipients.length > 1 ? "mms" : record.transport,
			participants: Array.from(new Set([
				...(record.participants || []),
				record.sender,
				...outboundRecipients,
			].map(normalizeAddress).filter(Boolean))).sort(),
			outboundRecipients,
			displayName: outboundRecipients.length > 1 ? `mms/${outboundRecipients.join(",")}` : record.displayName,
			updatedAt: new Date().toISOString(),
		};
		return this.sendFromRecord(groupRecord, text, attachments);
	}

	private async sendFromRecord(record: PhoneChannelRecord, text: string, attachments?: PhoneOutboundAttachment[]): Promise<string> {
		if (record.hostManaged && attachments?.length) {
			throw new Error("Host-managed phone channels support direct text messages only");
		}
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
				void text;
				void options;
				// User-visible phone messages must be authored through send_message.
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
			setWorking: async () => {},
			deleteMessage: async () => {
				// No-op.
			},
			restartWorking: async () => {
				// No harness-authored response is buffered.
			},
		};
	}

	private upsertChannel(payload: PhoneInboundPayload): PhoneChannelRecord {
		if (payload.hostManaged) return this.upsertHostManagedChannel(payload);
		const sender = normalizeAddress(payload.sender || payload.to || "unknown-sender");
		const from = normalizeAddress(payload.from);
		const participants = Array.from(new Set([from, sender, ...(payload.recipients || []).map(normalizeAddress)].filter(Boolean))).sort();
		const conversationId = payload.conversationId || participants.join("|");
		const channelId = `phone-${createHash("sha256").update(`${payload.provider}:${sender}:${conversationId}`).digest("hex").slice(0, 20)}`;
		const transport = payload.transport || "unknown";
		const displayName = `${transport}/${from}`;
		const existing = this.channels.get(channelId);
		const outboundRecipients = outboundRecipientsForGroup(from, sender, payload.recipients || [], existing?.outboundRecipients || []);
		const record: PhoneChannelRecord = {
			...(existing || {} as PhoneChannelRecord),
			channelId,
			provider: payload.provider,
			transport,
			conversationId,
			from,
			sender,
			participants,
			outboundRecipients,
			displayName,
			lastMessageId: payload.messageId,
			updatedAt: new Date().toISOString(),
			providerData: payload.providerData,
		};
		this.channels.set(channelId, record);
		this.saveChannelRegistry();
		return record;
	}

	private upsertHostManagedChannel(payload: PhoneInboundPayload): PhoneChannelRecord {
		const channelId = payload.channelId || payload.conversationId || "";
		if (!/^phone-[a-f0-9]{20}$/.test(channelId)) {
			throw new Error("Host-managed phone payload has an invalid opaque channel target");
		}
		if (!payload.hostContextId || !payload.displayName) {
			throw new Error("Host-managed phone payload lacks scoped context metadata");
		}
		if (payload.attachments?.length || payload.recipients?.length) {
			throw new Error("Host-managed phone payload must be direct text only");
		}
		const existing = this.channels.get(channelId);
		if (
			existing
			&& (
				!existing.hostManaged
				|| existing.hostContextId !== payload.hostContextId
			)
		) {
			throw new Error("Host-managed phone channel conflicts with persisted scope");
		}
		const record: PhoneChannelRecord = {
			...(existing || {} as PhoneChannelRecord),
			channelId,
			provider: "hostd",
			transport: "sms",
			conversationId: channelId,
			from: payload.displayName,
			sender: "hostd",
			participants: [],
			outboundRecipients: undefined,
			displayName: payload.displayName.slice(0, 80),
			lastMessageId: payload.messageId,
			updatedAt: new Date().toISOString(),
			providerData: undefined,
			hostManaged: true,
			hostContextId: payload.hostContextId,
			deliveryId: payload.deliveryId,
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

	private deliveryLedgerPath(): string {
		return join(this.workingDir, "phone-inbound-deliveries.jsonl");
	}

	private loadCompletedDeliveryIds(): Set<string> {
		if (this.completedDeliveryIds) return this.completedDeliveryIds;
		const ids = new Set<string>();
		try {
			for (const line of readFileSync(this.deliveryLedgerPath(), "utf8").split("\n")) {
				if (!line.trim()) continue;
				const record = JSON.parse(line) as { deliveryId?: unknown };
				if (typeof record.deliveryId === "string" && record.deliveryId) ids.add(record.deliveryId);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error("phone delivery ledger is unreadable");
			}
		}
		this.completedDeliveryIds = ids;
		return ids;
	}

	private isCompletedDelivery(deliveryId: string): boolean {
		return this.loadCompletedDeliveryIds().has(deliveryId);
	}

	private markDeliveryCompleted(deliveryId: string): void {
		const ids = this.loadCompletedDeliveryIds();
		if (ids.has(deliveryId)) return;
		appendFileSync(
			this.deliveryLedgerPath(),
			`${JSON.stringify({ deliveryId, completedAt: new Date().toISOString() })}\n`,
			{ mode: 0o600 },
		);
		ids.add(deliveryId);
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

function isAuthorizedVpsIngress(req: IncomingMessage): boolean {
	const expected = process.env.MOM_PHONE_INBOUND_TOKEN?.trim();
	if (process.env.MOM_PHONE_HOST_MANAGED === "true") {
		if (!expected || req.headers["x-tinyfat-hostd-verified"] !== "true") return false;
		const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
		return constantTimeEqual(supplied, expected);
	}
	if (!expected) return true;
	if (req.headers["x-crawdad-vps-verified"] !== "true") return false;
	const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
	return constantTimeEqual(supplied, expected);
}

function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return diff === 0;
}

function normalizeAddress(value: string): string {
	return value.trim().toLowerCase();
}

function outboundRecipientsForGroup(from: string, sender: string, recipients: string[], existing: string[] = []): string[] {
	const normalizedSender = normalizeAddress(sender);
	const candidates = [
		from,
		...recipients,
		...existing,
	].map(normalizeAddress).filter(Boolean);

	return Array.from(new Set(candidates))
		.filter((recipient) => recipient !== normalizedSender);
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
