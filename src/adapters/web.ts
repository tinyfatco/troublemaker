import { appendFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { AsyncLocalStorage } from "async_hooks";
import { timingSafeEqual } from "crypto";
import { join } from "path";
import { shouldSuppressAssistantSpeechEcho } from "../audio-feedback-guard.js";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import {
	slashCommandHandled,
	slashCommandPending,
	type ChannelInfo,
	type MomContext,
	type MomEvent,
	type MomHandler,
	type PlatformAdapter,
	type RunResult,
	type UserInfo,
} from "./types.js";

// ============================================================================
// WebAdapter — HTTP POST with SSE response (for web chat)
// ============================================================================

/**
 * Inbound web chat message from the orchestrator.
 * The orchestrator translates browser messages to this format.
 */
interface WebChatPayload {
	message?: string;
	text?: string;
	formatted_text?: string;
	append_text?: string;
	channelId?: string;
	channel_id?: string;
	freshContext?: boolean;
	fresh_context?: boolean;
	resetContext?: boolean;
	reset_context?: boolean;
	sessionId?: string;
	session_id?: string;
	sourceEventType?: string;
	source_event_type?: string;
	event_type?: string;
	source?: string;
	origin?: string;
	role?: string;
	speaker?: string;
	isBot?: boolean;
	assistant?: boolean;
}

interface NormalizedWebChatPayload {
	message: string;
	channelId: string;
	user: string;
	userName: string;
	freshContext: boolean;
	sessionId?: string;
	sourceEventType?: string;
}

interface WebStopPayload {
	channelId?: string;
}

interface WriterScope {
	channelId: string;
	writer: SSEWriter;
}

export interface WebAdapterConfig {
	workingDir: string;
	/** Optional bearer token required by every POST input route. */
	inputToken?: string;
}

/**
 * SSE writer — sends events to the HTTP response as Server-Sent Events.
 */
class SSEWriter {
	private res: ServerResponse;
	private closed = false;
	errorSent = false;

	constructor(res: ServerResponse) {
		this.res = res;
	}

	send(event: Record<string, unknown>): void {
		if (this.closed) return;
		if (event.type === "error") {
			this.errorSent = true;
		}
		try {
			this.res.write(`data: ${JSON.stringify(event)}\n\n`);
		} catch {
			this.closed = true;
		}
	}

	done(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.res.write("data: [DONE]\n\n");
			this.res.end();
		} catch {
			// Already closed
		}
	}
}

export class WebAdapter implements PlatformAdapter {
	readonly name = "web";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Web Chat Formatting (Markdown)
You are responding via web chat. Use standard Markdown formatting.
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)
Keep responses concise and helpful.`;

	private workingDir: string;
	private inputToken?: string;
	private handler!: MomHandler;
	/** Per-channel SSE writer — set in dispatch, read in createContext */
	private pendingWriters = new Map<string, SSEWriter>();
	private writerScope = new AsyncLocalStorage<WriterScope>();

	constructor(config: WebAdapterConfig) {
		this.workingDir = config.workingDir;
		this.inputToken = config.inputToken?.trim() || undefined;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("WebAdapter: handler not set. Call setHandler() before start().");
		log.logInfo("Web chat adapter ready");
		log.logConnected();
	}

	async stop(): Promise<void> {
		// No-op — gateway owns the HTTP server
	}

	// ==========================================================================
	// HTTP request handling — called by Gateway
	// ==========================================================================

	private authorize(req: IncomingMessage, res: ServerResponse): boolean {
		if (!this.inputToken) return true;
		const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
		const match = header.match(/^Bearer\s+(.+)$/i);
		const supplied = Buffer.from(match?.[1] || "", "utf8");
		const expected = Buffer.from(this.inputToken, "utf8");
		const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected);
		if (authorized) return true;
		res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
		return false;
	}

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		if (!this.authorize(req, res)) return;
		this.readPayload(req, res, (payload) => {
			const normalized = this.normalizePayload(payload);
			if (!normalized) {
				res.writeHead(400);
				res.end("Missing required field: message");
				return;
			}

			// Set up SSE response headers — keep connection open for streaming
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.flushHeaders?.();

			const writer = new SSEWriter(res);
			writer.send({ type: "status", status: "accepted", message: "Message accepted" });

			this.writerScope.run({ channelId: normalized.channelId, writer }, () => {
				this.processMessage(normalized, writer).catch((err) => {
					log.logWarning("Web chat processing error", err instanceof Error ? err.message : String(err));
					writer.send({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
					writer.done();
				});
			});
		});
	}

	dispatchStop(req: IncomingMessage, res: ServerResponse): void {
		if (!this.authorize(req, res)) return;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			let payload: WebStopPayload = {};
			const body = Buffer.concat(chunks).toString("utf-8").trim();
			if (body) {
				try {
					payload = JSON.parse(body);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
					return;
				}
			}

			const channelId = payload.channelId || "web";
			this.handler.handleStop(channelId, this)
				.then(() => {
					res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ ok: true }));
				})
				.catch((err) => {
					res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
					res.end(JSON.stringify({
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					}));
				});
		});
	}

	dispatchWebhook(req: IncomingMessage, res: ServerResponse): void {
		if (!this.authorize(req, res)) return;
		this.readPayload(req, res, (payload) => {
			const normalized = this.normalizePayload(payload);
			if (!normalized) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Missing required field: message or text" }));
				return;
			}

			const assistantOrigin = this.isAssistantOriginPayload(payload);
			const suppression = assistantOrigin
				? { suppress: true, reason: "assistant_origin_metadata" }
				: shouldSuppressAssistantSpeechEcho(normalized.message);
			if (suppression.suppress) {
				log.logInfo(
					`[web] Suppressed assistant speech echo from webhook: ${normalized.message.substring(0, 120)} ` +
					`(${suppression.reason}${"similarity" in suppression && typeof suppression.similarity === "number" ? `, similarity=${suppression.similarity.toFixed(2)}` : ""})`,
				);
				res.writeHead(202, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, channelId: normalized.channelId, suppressed: true, reason: suppression.reason }));
				return;
			}

			res.writeHead(202, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, channelId: normalized.channelId }));

			this.processMessage(normalized).catch((err) => {
				log.logWarning("Web webhook processing error", err instanceof Error ? err.message : String(err));
			});
		});
	}

	private readPayload(
		req: IncomingMessage,
		res: ServerResponse,
		onPayload: (payload: WebChatPayload) => void,
	): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf-8");

			let payload: WebChatPayload;
			try {
				payload = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			onPayload(payload);
		});
	}

	private normalizePayload(payload: WebChatPayload): NormalizedWebChatPayload | null {
		const rawMessage = this.firstString(
			payload.message,
			payload.text,
			payload.formatted_text,
			payload.append_text,
		);
		const message = rawMessage.trim();
		if (!message) return null;

		const source = typeof payload.source === "string" && payload.source.trim()
			? payload.source.trim()
			: "web";
		const channelId = (this.firstString(payload.channelId, payload.channel_id) || source).trim() || "web";
		const sessionId = this.firstString(payload.sessionId, payload.session_id).trim();
		const sourceEventType = this.firstString(payload.sourceEventType, payload.source_event_type).trim();
		const legacyEventType = this.firstString(payload.event_type).trim().toLowerCase();
		const normalizedSource = source.toLowerCase();
		const isVoiceSource = ["voice", "web-voice", "realtime-voice"].includes(normalizedSource)
			|| normalizedSource.includes("yappatron")
			|| legacyEventType.includes("utterance");

		return {
			message,
			channelId,
			user: source === "web" ? "web-user" : `${source}-user`,
			userName: source === "web" ? "user" : source,
			freshContext: payload.freshContext === true || payload.fresh_context === true || payload.resetContext === true || payload.reset_context === true,
			...(sessionId ? { sessionId } : {}),
			...(sourceEventType
				? { sourceEventType }
				: isVoiceSource
					? { sourceEventType: "web_voice" }
					: {}),
		};
	}

	private firstString(...values: unknown[]): string {
		for (const value of values) {
			if (typeof value === "string") return value;
		}
		return "";
	}

	private isAssistantOriginPayload(payload: WebChatPayload): boolean {
		if (payload.isBot === true || payload.assistant === true) return true;
		const origin = this.firstString(payload.origin, payload.role, payload.speaker)
			.trim()
			.toLowerCase();
		if (["assistant", "bot", "noodle", "troublemaker"].includes(origin)) return true;
		const source = this.firstString(payload.source).trim().toLowerCase();
		return ["assistant", "bot"].includes(source);
	}

	// ==========================================================================
	// Message processing
	// ==========================================================================

	private async processMessage(payload: NormalizedWebChatPayload, writer?: SSEWriter): Promise<void> {
		const channelId = payload.channelId;
		const ts = String(Date.now());
		let ownsWriter = false;
		let keepalive: ReturnType<typeof setInterval> | undefined;

		log.logInfo(`[web] Inbound: ${payload.message.substring(0, 80)}`);

		const event: MomEvent = {
			type: "dm",
			channel: channelId,
			ts,
			user: payload.user,
			text: payload.message,
			rawText: payload.message,
			freshContext: payload.freshContext,
			sessionId: payload.sessionId,
			sourceEventType: payload.sourceEventType,
			directlyAddressed: true,
		};

		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `web:${channelId}`,
			channelId,
			user: payload.user,
			userName: payload.userName,
			text: event.text,
			freshContext: payload.freshContext,
			sessionId: payload.sessionId,
			sourceEventType: payload.sourceEventType,
			attachments: [],
			isBot: false,
		});

		try {
			if (this.handler.resolvePendingInput(channelId, event.text)) {
				return;
			}

			if (event.text.trim().startsWith("/")) {
				if (writer) {
					this.pendingWriters.set(channelId, writer);
					ownsWriter = true;
					keepalive = setInterval(() => {
						writer.send({ type: "heartbeat", ts: Date.now() });
					}, 12000);
				}
				const commandResult = await this.handler.handleSlashCommand(event, this);
				const pending = slashCommandPending(commandResult);
				if (pending && writer) {
					await pending;
				}
				if (slashCommandHandled(commandResult)) return;
			}

			if (event.text.toLowerCase().trim() === "stop") {
				await this.handler.handleStop(channelId, this);
				return;
			}

			if (this.handler.isRunning(channelId)) {
				log.logInfo(`[web] Steering active run for ${channelId}`);
				if (writer) {
					this.pendingWriters.set(channelId, writer);
					ownsWriter = true;
					keepalive = setInterval(() => {
						writer.send({ type: "heartbeat", ts: Date.now() });
					}, 12000);
					writer.send({ type: "status", status: "steering", message: "Updating active run" });
				}
				this.handler.handleSteer(event, this);
				if (writer) await this.waitForIdle(channelId, writer);
				return;
			}

			if (writer) {
				this.pendingWriters.set(channelId, writer);
				ownsWriter = true;
				keepalive = setInterval(() => {
					writer.send({ type: "heartbeat", ts: Date.now() });
				}, 12000);
			}
			const result = await this.handler.handleEvent(event, this);
			this.surfaceRunError(result, writer);
		} finally {
			if (keepalive) clearInterval(keepalive);
			if (ownsWriter && this.pendingWriters.get(channelId) === writer) {
				this.pendingWriters.delete(channelId);
			}
			writer?.done();
		}
	}

	private surfaceRunError(result: RunResult | void, writer?: SSEWriter): void {
		if (!writer || writer.errorSent || !result) return;
		if (result.stopReason !== "error") return;

		const message = this.formatStreamError(result.errorMessage || "Run failed");
		writer.send({ type: "error", message });
	}

	private formatStreamError(message: string): string {
		const normalized = message.replace(/\s+/g, " ").trim();
		const redacted = normalized
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
			.replace(/\b(?:sk|sess|ghp|gho|github_pat)_[A-Za-z0-9._~+/=-]{12,}\b/g, "[redacted-token]");
		return redacted.length > 1200 ? `${redacted.substring(0, 1200)}...` : redacted;
	}

	private async waitForIdle(channelId: string, writer: SSEWriter): Promise<void> {
		const deadline = Date.now() + 10 * 60 * 1000;
		while (this.handler.isRunning(channelId)) {
			if (Date.now() > deadline) {
				writer.send({ type: "error", message: "Timed out waiting for active run to finish" });
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}

	// ==========================================================================
	// PlatformAdapter — message operations (mostly no-ops for web)
	// ==========================================================================

	async postMessage(channel: string, text: string): Promise<string> {
		const ts = String(Date.now());
		const scoped = this.writerScope.getStore();
		const writer = scoped?.channelId === channel ? scoped.writer : this.pendingWriters.get(channel);
		if (writer) {
			writer.send({ type: "text", text });
		} else {
			log.logWarning(`[web] No active SSE writer for channel ${channel}; response logged only`);
		}
		this.logBotResponse(channel, text, ts);
		return ts;
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}

	async deleteMessage(_channel: string, _ts: string): Promise<void> {}

	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		return String(Date.now());
	}

	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	// ==========================================================================
	// Logging
	// ==========================================================================

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `web:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Metadata (web has no channels/users concept)
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

	enqueueEvent(_event: MomEvent): boolean {
		// Web chat requires an active SSE connection — can't deliver scheduled events
		return false;
	}

	// ==========================================================================
	// Context creation — streams SSE events back to the HTTP response
	//
	// The agent runner calls these methods during execution:
	// - respond("_→ Label_", false) → tool_start SSE event
	// - respond("_Error: ..._", false) → tool error
	// - respond(text, true) → token SSE event (response text)
	// - respondInThread(*✓ toolName*...) → tool_end SSE event
	// - setWorking(false) → run_complete SSE event
	// ==========================================================================

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		const scoped = this.writerScope.getStore();
		const writer = scoped?.channelId === event.channel ? scoped.writer : this.pendingWriters.get(event.channel);
		let lastToolId: string | undefined;

		return {
			message: {
				text: event.text,
				rawText: event.rawText ?? event.text,
				user: event.user,
				userName: "user",
				channel: event.channel,
				ts: event.ts,
				freshContext: event.freshContext,
				sessionId: event.sessionId,
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

			respond: async (_text: string, _shouldLog = true) => {
				// No-op — structured content delivered via emitContentBlock
			},

			sendFinalResponse: async (text: string) => {
				// Final text — already sent via respond(), no need to re-send
			},

			respondInThread: async (_text: string) => {
				// No-op — structured content delivered via emitContentBlock
			},

			setTyping: async () => {},

			uploadFile: async () => {},

			setWorking: async (working: boolean) => {
				if (!working && writer) {
					writer.send({ type: "run_complete", channelId: event.channel });
				}
			},

			deleteMessage: async () => {},

			restartWorking: async () => {
				// No-op for web — SSE stream is continuous
			},

			emitContentBlock: (block: { type: string; [key: string]: unknown }) => {
				if (writer) writer.send(block);
			},
		};
	}
}
