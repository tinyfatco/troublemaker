import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { basename, join } from "path";
import { MomSettingsManager } from "../context.js";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { composeEmailReplyBody, type EmailReplyQuote } from "./email/reply-composer.js";
import { buildReplyThreadHeaders } from "./email/thread-headers.js";
import {
	appendEmailThreadEvent,
	emailThreadIdForEvent,
	latestInboundEmailThreadEvent,
	parseEmailThreadTarget,
} from "./email/thread-ledger.js";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, UserInfo } from "./types.js";

// ============================================================================
// EmailWebhookAdapter — receives email via HTTP, runs agent, sends one reply
// ============================================================================

/**
 * Inbound email payload from the email inbound webhook → orchestrator → here.
 * Matches TriggerPayload from fat-agents/src/lib/email/inbound-types.ts
 */
interface EmailPayload {
	from: string;
	fromFull?: string;
	to: string;
	subject: string;
	body: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string;
	allRecipients?: string[];
	emailChannel?: string | null;
	replyQuote?: {
		body: string;
		from?: string;
		sentAt?: string;
	};
	attachments?: Array<{
		filename: string;
		content_type: string;
		content: string; // base64
	}>;
}

export interface EmailWebhookAdapterConfig {
	workingDir: string;
	/** Agent's tools_token for authenticating against TinyFat API */
	toolsToken: string;
	/** URL for sending email replies (e.g., https://tinyfat.com/api/email/send) */
	sendUrl: string;
	/** Optional bearer token required for trusted upstream webhook delivery. */
	inboundToken?: string;
}

interface ActiveEmailReplyContext {
	channelId: string;
	canonicalChannel: string;
	toAddress: string;
	subject: string;
	messageId?: string;
	references?: string;
	replyQuote?: EmailReplyQuote;
	explicitOutboundSent?: boolean;
	threadTarget?: string;
}

interface LoggedEmailThreadEntry {
	ts: string;
	date?: string;
	channelId?: string;
	user?: string;
	text?: string;
	isBot?: boolean;
}

interface EmailThreadTurn {
	body: string;
	from: string;
	sentAt?: string;
}

export function matchesBearerToken(header: string | undefined, expected: string): boolean {
	const actualBytes = Buffer.from(header?.replace(/^Bearer\s+/i, "") || "");
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export class EmailWebhookAdapter implements PlatformAdapter {
	readonly name = "email";
	readonly maxMessageLength = 100000; // Email has no real limit
	readonly formatInstructions = `## Email Formatting (Markdown)
You are responding via email. Use standard Markdown formatting.
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)
Keep responses concise and professional. The user will receive one email with your complete response.`;

	private workingDir: string;
	private toolsToken: string;
	private sendUrl: string;
	private inboundToken?: string;
	private handler!: MomHandler;
	/** Per-channel email metadata for threading (set in processEmail, read in createContext) */
	private pendingPayloads = new Map<string, EmailPayload>();
	/** Active reply contexts used by send_message to preserve email threading */
	private activeReplyContexts = new Map<string, ActiveEmailReplyContext>();

	constructor(config: EmailWebhookAdapterConfig) {
		this.workingDir = config.workingDir;
		this.toolsToken = config.toolsToken;
		this.sendUrl = config.sendUrl;
		this.inboundToken = config.inboundToken;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("EmailWebhookAdapter: handler not set. Call setHandler() before start().");
		log.logInfo("Email webhook adapter ready");
		log.logConnected();
	}

	async stop(): Promise<void> {
		// No-op — gateway owns the HTTP server
	}

	// ==========================================================================
	// HTTP request handling — called by Gateway
	// ==========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		if (this.inboundToken && !matchesBearerToken(req.headers.authorization, this.inboundToken)) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const body = Buffer.concat(chunks).toString("utf-8");

			let payload: EmailPayload;
			try {
				payload = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			if (!payload.from || !payload.body) {
				res.writeHead(400);
				res.end("Missing required fields: from, body");
				return;
			}

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));

			// Process email
			try {
				await this.processEmail(payload);
			} catch (err) {
				log.logWarning("Email processing error", err instanceof Error ? err.message : String(err));
			}
		});
	}

	// ==========================================================================
	// Email processing
	// ==========================================================================

	private async processEmail(payload: EmailPayload): Promise<void> {
		// Use a stable channel ID derived from the sender email
		// This groups all emails from the same sender into one conversation
		const channelId = `email-${payload.from.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
		const ts = String(Date.now());

		log.logInfo(`[email] Inbound from ${payload.from}: ${payload.subject || "(no subject)"}`);

		// Save attachments to disk so the agent can read them
		const savedPaths = this.saveAttachments(payload, channelId);

		const event: MomEvent = {
			type: "dm",
			channel: channelId,
			ts,
			user: payload.from,
			text: this.buildMessageText(payload, savedPaths),
			rawText: payload.body,
			sourceEventType: "email_received",
			directlyAddressed: true,
			replyTarget: `email-${payload.from}`,
			replyTargetDescription: `Email reply thread for ${payload.from}`,
		};

		// Store payload for createContext to read (threading metadata)
		this.pendingPayloads.set(channelId, payload);

		// Log the inbound message
			this.logToFile({
				date: new Date().toISOString(),
				ts,
			channel: `email:${payload.from}`,
			channelId,
			user: payload.from,
			userName: payload.from.split("@")[0],
			text: event.text,
				attachments: [],
				isBot: false,
			});
			this.logThreadEvent({
				type: "inbound",
				at: new Date().toISOString(),
				channelId,
				from: payload.from,
				to: [payload.to],
				subject: payload.subject,
				body: payload.body,
				messageId: payload.messageId,
				inReplyTo: payload.inReplyTo,
				references: payload.references,
			});

		if (this.handler.isRunning(channelId)) {
			log.logInfo(`[email] Already running for ${channelId}, interrupting active run`);
			this.handler.handleSteer(event, this);
			return;
		}

		try {
			await this.handler.handleEvent(event, this);
		} finally {
			this.pendingPayloads.delete(channelId);
		}
	}

	private buildMessageText(payload: EmailPayload, savedPaths: Map<string, string>): string {
		const parts: string[] = [];

		if (payload.subject) {
			parts.push(`Subject: ${payload.subject}`);
		}

		parts.push(payload.body);

		if (savedPaths.size > 0) {
			const fileList = Array.from(savedPaths.entries())
				.map(([filename, path]) => `- ${filename}: ${path}`)
				.join("\n");
			parts.push(`Attachments saved to disk:\n${fileList}`);
		}

		return parts.join("\n\n");
	}

	private saveAttachments(payload: EmailPayload, _channelId: string): Map<string, string> {
		const saved = new Map<string, string>();
		if (!payload.attachments || payload.attachments.length === 0) return saved;

		const dir = join(this.workingDir, "attachments");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		for (const att of payload.attachments) {
			try {
				const buffer = Buffer.from(att.content, "base64");
				const filePath = join(dir, att.filename);
				writeFileSync(filePath, buffer);
				saved.set(att.filename, filePath);
				log.logInfo(`[email] Saved attachment: ${att.filename} (${buffer.length} bytes) → ${filePath}`);
			} catch (err) {
				log.logWarning(`[email] Failed to save attachment ${att.filename}`, err instanceof Error ? err.message : String(err));
			}
		}

		return saved;
	}

	private normalizeEmailAddress(value: string): string {
		const trimmed = value.trim();
		const angleMatch = trimmed.match(/<([^>]+)>/);
		return (angleMatch ? angleMatch[1] : trimmed).toLowerCase();
	}

	private buildReplySubject(subject: string): string {
		return subject.startsWith("Re:") ? subject : `Re: ${subject}`;
	}

	private extractSubjectFromLoggedText(text: string): string | undefined {
		const match = text.match(/^Subject:\s*(.+)$/m);
		return match?.[1]?.trim();
	}

	private normalizeThreadSubject(subject?: string): string {
		return (subject || "")
			.trim()
			.replace(/^(?:\s*(?:re|fwd):)+\s*/i, "")
			.toLowerCase();
	}

	private stripEmailLogDecorations(text: string): string {
		let cleaned = text.replace(/^Subject:\s*.+?(?:\n\n|$)/, "");
		const attachmentsIndex = cleaned.indexOf("\n\nAttachments saved to disk:\n");
		if (attachmentsIndex !== -1) {
			cleaned = cleaned.slice(0, attachmentsIndex);
		}
		return cleaned.trim();
	}

	private resolveLoggedEntrySentAt(entry: LoggedEmailThreadEntry): string | undefined {
		if (entry.date?.trim()) return entry.date;
		const tsNum = Number(entry.ts);
		if (Number.isNaN(tsNum)) return undefined;
		return new Date(tsNum).toISOString();
	}

	private buildConversationReplyBody(channelId: string, payload: EmailPayload, currentTs: string): string | undefined {
		const logPath = join(this.workingDir, "log.jsonl");
		if (!existsSync(logPath)) return undefined;

		let raw: string;
		try {
			raw = readFileSync(logPath, "utf-8");
		} catch {
			return undefined;
		}

		const currentTsNum = Number(currentTs);
		const channelEntries = raw
			.split("\n")
			.map((line) => {
				if (!line.trim()) return undefined;
				try {
					return JSON.parse(line) as LoggedEmailThreadEntry;
				} catch {
					return undefined;
				}
			})
			.filter((entry): entry is LoggedEmailThreadEntry => {
				if (!entry?.channelId || entry.channelId !== channelId || !entry.text) return false;
				const tsNum = Number(entry.ts);
				return Number.isNaN(tsNum) ? true : tsNum <= currentTsNum;
			});

		if (channelEntries.length === 0) return undefined;

		const currentEntry = channelEntries[channelEntries.length - 1];
		const currentBody = (payload.replyQuote?.body || this.stripEmailLogDecorations(currentEntry.text || payload.body) || payload.body).trim();
		if (!currentBody) return undefined;

		const currentSubject = this.normalizeThreadSubject(payload.subject);
		const priorEntries: LoggedEmailThreadEntry[] = [];
		let pendingBots: LoggedEmailThreadEntry[] = [];

		for (let i = channelEntries.length - 2; i >= 0; i--) {
			const entry = channelEntries[i];
			if (!entry.text) continue;

			if (entry.isBot) {
				pendingBots.unshift(entry);
				continue;
			}

			const entrySubject = this.normalizeThreadSubject(this.extractSubjectFromLoggedText(entry.text));
			if (currentSubject && entrySubject && entrySubject !== currentSubject) {
				break;
			}

			priorEntries.unshift(...pendingBots);
			pendingBots = [];
			priorEntries.unshift(entry);
		}

		const turns = priorEntries.reduce<EmailThreadTurn[]>((acc, entry) => {
			const body = this.stripEmailLogDecorations(entry.text || "");
			if (!body) return acc;
			acc.push({
				body,
				from: entry.isBot ? payload.to : payload.from,
				sentAt: this.resolveLoggedEntrySentAt(entry),
			});
			return acc;
		}, []);

		turns.push({
			body: currentBody,
			from: payload.from,
			sentAt: payload.replyQuote?.sentAt || this.resolveLoggedEntrySentAt(currentEntry),
		});

		if (turns.length === 1) return currentBody;

		let threadBody = turns[0].body;
		for (let i = 1; i < turns.length; i++) {
			const previousTurn = turns[i - 1];
			threadBody = composeEmailReplyBody(turns[i].body, {
				body: threadBody,
				from: previousTurn.from,
				sentAt: previousTurn.sentAt,
			});
		}

		return threadBody;
	}

	private buildReplyQuote(channelId: string, payload: EmailPayload, currentTs: string, fallbackSentAt?: string): EmailReplyQuote | undefined {
		const body = this.buildConversationReplyBody(channelId, payload, currentTs) || payload.replyQuote?.body || payload.body;
		if (!body?.trim()) return undefined;
		return {
			body,
			from: payload.replyQuote?.from || payload.fromFull || payload.from,
			sentAt: payload.replyQuote?.sentAt || fallbackSentAt,
		};
	}

	private registerActiveReplyContext(channelId: string, payload: EmailPayload, currentTs: string): ActiveEmailReplyContext {
		const fallbackSentAt = new Date(Number(currentTs)).toISOString();
		const toAddress = this.normalizeEmailAddress(payload.from);
		const canonicalChannel = `email-${toAddress}`;
		const context: ActiveEmailReplyContext = {
			channelId,
			canonicalChannel,
			toAddress,
			subject: payload.subject || "(no subject)",
			messageId: payload.messageId,
			references: payload.references,
			replyQuote: this.buildReplyQuote(channelId, payload, currentTs, fallbackSentAt),
			threadTarget: `email-thread:${emailThreadIdForEvent({
				channelId,
				subject: payload.subject,
				messageId: payload.messageId,
				inReplyTo: payload.inReplyTo,
				references: payload.references,
			})}`,
		};
		this.activeReplyContexts.set(channelId, context);
		this.activeReplyContexts.set(canonicalChannel, context);
		if (context.threadTarget) this.activeReplyContexts.set(context.threadTarget, context);
		return context;
	}

	private clearActiveReplyContext(context?: ActiveEmailReplyContext): void {
		if (!context) return;
		this.activeReplyContexts.delete(context.channelId);
		this.activeReplyContexts.delete(context.canonicalChannel);
		if (context.threadTarget) this.activeReplyContexts.delete(context.threadTarget);
	}

	private resolveActiveReplyContext(channel: string): ActiveEmailReplyContext | undefined {
		const direct = this.activeReplyContexts.get(channel);
		if (direct) return direct;
		const emailMatch = channel.match(/^email-(.+)$/);
		if (!emailMatch) return undefined;
		return this.activeReplyContexts.get(`email-${this.normalizeEmailAddress(emailMatch[1])}`);
	}

	private resolveStoredReplyContext(channel: string): ActiveEmailReplyContext | undefined {
		const parsed = parseEmailThreadTarget(channel);
		if (!parsed) return undefined;
		const latestInbound = latestInboundEmailThreadEvent(this.workingDir, parsed.threadId);
		if (!latestInbound?.from) return undefined;
		const toAddress = this.normalizeEmailAddress(latestInbound.from);
		return {
			channelId: latestInbound.channelId,
			canonicalChannel: `email-${toAddress}`,
			toAddress,
			subject: latestInbound.subject || "(no subject)",
			messageId: latestInbound.messageId,
			references: latestInbound.references,
			replyQuote: latestInbound.body?.trim()
				? {
					body: latestInbound.body,
					from: latestInbound.from,
					sentAt: latestInbound.at,
				}
				: undefined,
			threadTarget: parsed.inputTarget,
		};
	}

	// ==========================================================================
	// PlatformAdapter — message operations (mostly no-ops for email)
	// ==========================================================================

	async postMessage(channel: string, text: string, attachments?: Array<{ filePath: string; filename: string }>, subject?: string): Promise<string> {
		// Cross-channel send: channel format is "email-{address}" or "email-thread:{id}"
		const emailMatch = channel.match(/^email-(.+)$/);
		const threadTarget = parseEmailThreadTarget(channel);
		if (!emailMatch && !threadTarget) {
			throw new Error(`postMessage called with non-email channel: ${channel}`);
		}

		const replyContext = this.resolveActiveReplyContext(channel) || this.resolveStoredReplyContext(channel);
		const toAddress = replyContext?.toAddress || this.normalizeEmailAddress(emailMatch?.[1] || "");
		if (!toAddress) {
			throw new Error(`Could not resolve email recipient for ${channel}. Use list_channels to choose a known email thread or email-{address}.`);
		}
		const body = replyContext ? composeEmailReplyBody(text, replyContext.replyQuote) : text;
		const resolvedSubject = replyContext
			? (subject || this.buildReplySubject(replyContext.subject))
			: (subject || "Message from your agent");
		log.logInfo(`[email] Sending ${replyContext ? "threaded " : ""}outbound to ${toAddress}${attachments?.length ? ` with ${attachments.length} attachment(s)` : ""}`);

		const emailMetadata: Record<string, unknown> = {
			to: toAddress,
			subject: resolvedSubject,
			body,
		};

		Object.assign(emailMetadata, buildReplyThreadHeaders(replyContext?.messageId, replyContext?.references));

		let response: Response;

		if (attachments && attachments.length > 0) {
			// Use multipart/form-data for emails with attachments
			log.logInfo(`[email] Using multipart for ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(", ")}`);

			const form = new FormData();
			form.append("metadata", JSON.stringify(emailMetadata));

			for (const att of attachments) {
				const buffer = readFileSync(att.filePath);
				form.append("attachments", new Blob([buffer]), att.filename);
				log.logInfo(`[email] Attached: ${att.filename} (${buffer.length} bytes)`);
			}

			response = await fetch(this.sendUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.toolsToken}`,
				},
				body: form,
			});
		} else {
			// No attachments — simple JSON
			response = await fetch(this.sendUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.toolsToken}`,
				},
				body: JSON.stringify(emailMetadata),
			});
		}

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Email send failed (${response.status}): ${errorText}`);
		}

		const result = (await response.json()) as { ok: boolean; messageId?: string };
		log.logInfo(`[email] Outbound sent: messageId=${result.messageId}`);
		if (replyContext && this.resolveActiveReplyContext(channel)) {
			replyContext.explicitOutboundSent = true;
		}
		this.logThreadEvent({
			type: "outbound",
			at: new Date().toISOString(),
			channelId: replyContext?.channelId || channel,
			to: [toAddress],
			subject: resolvedSubject,
			body: text,
			providerMessageId: result.messageId,
			inReplyTo: typeof emailMetadata.in_reply_to === "string" ? emailMetadata.in_reply_to : undefined,
			references: typeof emailMetadata.references === "string" ? emailMetadata.references : undefined,
		});
		return result.messageId || String(Date.now());
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {
		// No-op
	}

	async deleteMessage(_channel: string, _ts: string): Promise<void> {
		// No-op
	}

	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		// No-op — thread messages go to tool log
		return String(Date.now());
	}

	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {
		// TODO: email attachments in future
	}

	// ==========================================================================
	// Logging
	// ==========================================================================

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	private logThreadEvent(event: Parameters<typeof appendEmailThreadEvent>[1]): void {
		try {
			appendEmailThreadEvent(this.workingDir, event);
		} catch (err) {
			log.logWarning("[email] Failed to append thread ledger event", err instanceof Error ? err.message : String(err));
		}
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		// Normalize channelId to match processEmail's format (FAT-370):
		//   processEmail: `email-${from.toLowerCase().replace(/[^a-z0-9]/g, "_")}`
		// Without normalization, bot replies routed via send_message
		// arrive here as channel="email-alex@gmail.com" while inbound uses
		// channelId="email-alex_gmail_com" — and buildConversationReplyBody's
		// channelId filter never matches across turns.
		const replyContext = this.resolveActiveReplyContext(channel) || this.resolveStoredReplyContext(channel);
		const stripped = replyContext?.toAddress || (channel.startsWith("email-") ? channel.slice("email-".length) : channel);
		const normalizedChannelId = replyContext?.channelId || `email-${stripped.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `email:${stripped}`,
			channelId: normalizedChannelId,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Metadata (email has no channels/users concept)
	// ==========================================================================

	getUser(_userId: string): UserInfo | undefined {
		return undefined;
	}

	getChannel(_channelId: string): ChannelInfo | undefined {
		return undefined;
	}

	getAllUsers(): UserInfo[] {
		return [];
	}

	getAllChannels(): ChannelInfo[] {
		return [];
	}

	enqueueEvent(event: MomEvent): boolean {
		// Email channel IDs start with "email-"
		if (!event.channel.startsWith("email-")) return false;

		if (this.handler.isRunning(event.channel)) {
			log.logInfo(`[email] Already running for ${event.channel}, interrupting active run`);
			this.handler.handleSteer(event, this);
			return true; // Claim it so other adapters don't grab it
		}

		log.logInfo(`Enqueueing email event for ${event.channel}: ${event.text.substring(0, 50)}`);
		this.handler.handleEvent(event, this, true).catch((err) => {
			log.logWarning(`[email] Event handler error for ${event.channel}`, err instanceof Error ? err.message : String(err));
		});
		return true;
	}

	// ==========================================================================
	// Context creation — the key difference from Slack/Telegram
	//
	// Email context ACCUMULATES everything silently during the run.
	// On setWorking(false), it sends ONE email reply with:
	// - Agent's final text response
	// - Tool call log (concise labels + durations)
	// - Cost summary
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		const toolLog: string[] = [];
		const pendingAttachments: Array<{ filename: string; filePath: string }> = [];
		let finalText = "";
		let forceFinalResponse = false;
		const payload = this.pendingPayloads.get(event.channel);
		const activeReplyContext = payload ? this.registerActiveReplyContext(event.channel, payload, event.ts) : undefined;
		const messagesOnly = new MomSettingsManager(this.workingDir).getVerbose(event.channel, "email") === "messages-only";
		const emailMeta = {
			from: event.user,
			selfEmail: payload?.to?.toLowerCase(), // agent's own address — exclude from reply-all
			subject: payload?.subject || "(no subject)",
			messageId: payload?.messageId,
			inReplyTo: payload?.inReplyTo,
			references: payload?.references,
			allRecipients: payload?.allRecipients || [],
			replyQuote: activeReplyContext?.replyQuote,
		};

		return {
			message: {
				text: event.text,
				rawText: event.rawText ?? event.text,
				user: event.user,
				userName: event.user.split("@")[0],
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
			channelName: undefined,
			channels: [],
			users: [],

			respond: async (text: string, shouldLog = true) => {
				// Tool labels come as _→ Label_ with shouldLog=false
				if (!shouldLog && text.startsWith("_→")) {
					const label = text.replace(/^_→\s*/, "").replace(/_$/, "");
					toolLog.push(`→ ${label}`);
					return;
				}

				if (!shouldLog && text.startsWith("_") && text.endsWith("_")) {
					// Status messages (Thinking, Compacting, Retrying) — log but don't include in response
					toolLog.push(text.replace(/^_/, "").replace(/_$/, ""));
					return;
				}

				if (!shouldLog && text.startsWith("_Error:")) {
					// Tool errors — add to log
					toolLog.push(text.replace(/^_/, "").replace(/_$/, ""));
					return;
				}

				// Actual response text
				if (shouldLog && !messagesOnly) {
					finalText = finalText ? `${finalText}\n${text}` : text;
				}
			},

			sendFinalResponse: async (text: string, options = {}) => {
				const force = (options as { force?: boolean }).force === true;
				if (messagesOnly && !force) {
					finalText = "";
					forceFinalResponse = false;
					return;
				}
				forceFinalResponse = force;
				finalText = text;
			},

			respondInThread: async (text: string) => {
				// Thread messages are tool results — add to log
				toolLog.push(text);
			},

			setTyping: async () => {
				// No-op for email
			},

			uploadFile: async (filePath: string, title?: string) => {
				try {
					const filename = title || basename(filePath);
					// Store the file path so sendEmailReply can read binary directly
					// (avoids base64-in-JSON overhead for multipart sends)
					pendingAttachments.push({ filename, filePath });
					const stat = readFileSync(filePath);
					log.logInfo(`[email] Queued attachment: ${filename} (${stat.length} bytes) from ${filePath}`);
				} catch (err) {
					log.logWarning(`[email] Failed to read attachment ${filePath}`, err instanceof Error ? err.message : String(err));
				}
			},

			setWorking: async (working: boolean) => {
				if (!working) {
					// Run complete — send the email reply
					try {
						if (activeReplyContext?.explicitOutboundSent && !forceFinalResponse) {
							log.logInfo(`[email] Explicit outbound already sent for ${event.channel}; suppressing adapter final reply`);
							return;
						}
						await this.sendEmailReply(emailMeta, finalText, toolLog, pendingAttachments, event.channel);
					} finally {
						this.clearActiveReplyContext(activeReplyContext);
					}
				}
			},

			deleteMessage: async () => {
				// No-op for email
			},

			restartWorking: async () => {
				// No-op for email
			},
		};
	}

	// ==========================================================================
	// Email reply — the one outbound message
	// ==========================================================================

	private async sendEmailReply(
		meta: { from: string; selfEmail?: string; subject: string; messageId?: string; inReplyTo?: string; references?: string; allRecipients?: string[]; replyQuote?: EmailReplyQuote },
		finalText: string,
		toolLog: string[],
		attachments: Array<{ filename: string; filePath: string }> = [],
		channelId?: string,
	): Promise<void> {
		if (!finalText.trim()) {
			log.logInfo("[email] No response text to send");
			return;
		}

		// Build the concise work log
		const conciseLog = this.buildConciseLog(toolLog);
		const replyBody = composeEmailReplyBody(finalText, meta.replyQuote);
		const logModeEnv = (process.env.MOM_EMAIL_LOG_MODE || "none").toLowerCase();
		const logMode = logModeEnv === "inline" || logModeEnv === "attachment" ? logModeEnv : "none";

		const replySubject = meta.subject.startsWith("Re:") ? meta.subject : `Re: ${meta.subject}`;

		// Reply-all: combine sender + all other recipients, deduped
		// Filter out the agent's own address to avoid CC'ing itself
		const allTo = new Set<string>();
		allTo.add(meta.from.toLowerCase());
		if (meta.allRecipients) {
			for (const addr of meta.allRecipients) {
				const lower = addr.toLowerCase();
				if (meta.selfEmail && lower === meta.selfEmail) continue;
				allTo.add(lower);
			}
		}
		const toList = Array.from(allTo).join(", ");

		const emailMetadata: Record<string, unknown> = {
			to: toList,
			subject: replySubject,
			body: replyBody,
		};

		// Human-facing email defaults to no inline work log.
		// Operators can opt back in with MOM_EMAIL_LOG_MODE=inline|attachment.
		if (conciseLog && logMode !== "none") {
			emailMetadata.log = logMode;
			emailMetadata.log_content = conciseLog;
		}

		Object.assign(emailMetadata, buildReplyThreadHeaders(meta.messageId, meta.references));

		log.logInfo(`[email] Sending reply to ${toList}: ${replySubject}`);

		try {
			let response: Response;

			if (attachments.length > 0) {
				// Use multipart/form-data for emails with attachments
				// Sends binary files directly — no base64-in-JSON overhead
				log.logInfo(`[email] Using multipart for ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(", ")}`);

				const form = new FormData();
				form.append("metadata", JSON.stringify(emailMetadata));

				for (const att of attachments) {
					const buffer = readFileSync(att.filePath);
					form.append("attachments", new Blob([buffer]), att.filename);
				}

				response = await fetch(this.sendUrl, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.toolsToken}`,
						// Let fetch set Content-Type with boundary automatically
					},
					body: form,
				});
			} else {
				// No attachments — use simple JSON (existing path)
				response = await fetch(this.sendUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.toolsToken}`,
					},
					body: JSON.stringify(emailMetadata),
				});
			}

			if (!response.ok) {
				const errorText = await response.text();
				log.logWarning(`[email] Send failed: ${response.status}`, errorText);
			} else {
				const result = (await response.json()) as { ok: boolean; messageId?: string };
				log.logInfo(`[email] Reply sent: messageId=${result.messageId}`);

				// FAT-370: log the bot's outbound reply so future replies in this thread
				// can include the agent's prior content in the quoted body.
				// Without this, buildConversationReplyBody finds no isBot:true entries
				// for this channelId and the agent loses its own context across turns.
					if (channelId) {
						this.logBotResponse(channelId, finalText, String(Date.now()));
					}
					this.logThreadEvent({
						type: "outbound",
						at: new Date().toISOString(),
						channelId: channelId || "",
						to: toList.split(",").map((addr) => addr.trim()).filter(Boolean),
						subject: replySubject,
						body: finalText,
						providerMessageId: result.messageId,
						inReplyTo: typeof emailMetadata.in_reply_to === "string" ? emailMetadata.in_reply_to : undefined,
						references: typeof emailMetadata.references === "string" ? emailMetadata.references : undefined,
					});
				}
		} catch (err) {
			log.logWarning("[email] Send error", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Build a concise work log from the accumulated tool log entries.
	 * Extracts just the tool labels and durations from the verbose thread messages.
	 */
	private buildConciseLog(toolLog: string[]): string {
		const lines: string[] = [];
		let toolCount = 0;

		for (const entry of toolLog) {
			// Tool start labels: "→ Reading file"
			if (entry.startsWith("→ ")) {
				lines.push(entry);
				toolCount++;
				continue;
			}

			// Tool result thread messages: "*✓ bash*: Running git status (1.2s)"
			// Extract just the summary line
			const toolMatch = entry.match(/^\*([✓✗]) (\w+)\*(?:: (.+?))? \((\d+\.\d+)s\)/);
			if (toolMatch) {
				const [, status, toolName, label, duration] = toolMatch;
				const displayLabel = label || toolName;
				lines.push(`${status === "✓" ? "→" : "✗"} ${displayLabel} (${duration}s)`);
				if (!entry.startsWith("→ ")) toolCount++;
				continue;
			}

			// Status messages (Thinking, Compacting, Retrying) — include as-is
			if (entry.startsWith("Thinking") || entry.startsWith("Compacting") || entry.startsWith("Retrying")) {
				lines.push(entry);
			}
		}

		if (lines.length === 0) return "";

		return `Work log:\n${lines.join("\n")}\n${toolCount} tool calls`;
	}
}
