import { appendFileSync } from "fs";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { join } from "path";
import WebSocket, { WebSocketServer } from "ws";
import {
	beginAssistantSpeech,
	finishAssistantSpeech,
	shouldSuppressAssistantSpeechEcho,
} from "../audio-feedback-guard.js";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import type { LocalEventboxClient, LocalEventboxEvent } from "../local/eventbox-client.js";
import {
	slashCommandHandled,
	slashCommandPending,
	type ChannelInfo,
	type MomContext,
	type MomEvent,
	type MomHandler,
	type PlatformAdapter,
	type UserInfo,
} from "./types.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";
const REALTIME_MODEL = "gpt-realtime-2";
const TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const DEFAULT_VOICE = "marin";
const REALTIME_CHANNEL_ID = "mac-realtime";
const REALTIME_CHANNEL_NAME = "realtime voice";
const REALTIME_USER_ID = "mac-user";
const REALTIME_USER_NAME = "Alex";
const OPENAI_PLACEHOLDER_KEY = "sk-tfat-egress-openai-placeholder";

export interface RealtimeVoiceBridgeConfig {
	workingDir: string;
	handler: MomHandler;
	eventbox?: LocalEventboxClient;
}

interface RealtimeClientStart {
	type: "start";
	apiKey?: string;
	voice?: string;
}

interface RealtimeClientControl {
	type?: string;
	apiKey?: string;
	voice?: string;
}

export function createRealtimeVoiceInstructions(): string {
	return [
		"You are Troublemaker's voice transport, not the agent brain.",
		"Use the microphone audio only to produce input transcription events.",
		"Do not answer the user from this Realtime session.",
		"When the server creates an audio response for canonical assistant text, speak that supplied text exactly and add no extra words.",
	].join("\n");
}

export function createRealtimeAudioConfig(voice = DEFAULT_VOICE): Record<string, unknown> {
	return {
		input: {
			format: { type: "audio/pcm", rate: 24000 },
			noise_reduction: { type: "far_field" },
			turn_detection: {
				type: "server_vad",
				create_response: false,
				interrupt_response: false,
				prefix_padding_ms: 250,
				silence_duration_ms: 450,
				threshold: 0.6,
			},
			transcription: { model: TRANSCRIPTION_MODEL },
		},
		output: {
			format: { type: "audio/pcm", rate: 24000 },
			voice,
			speed: 1.0,
		},
	};
}

export function createRealtimeSessionUpdate(options: { voice?: string } = {}): Record<string, unknown> {
	return {
		type: "session.update",
		session: {
			type: "realtime",
			model: REALTIME_MODEL,
			output_modalities: ["audio"],
			instructions: createRealtimeVoiceInstructions(),
			tools: [],
			parallel_tool_calls: false,
			audio: createRealtimeAudioConfig(options.voice ?? DEFAULT_VOICE),
		},
	};
}

export function createCanonicalSpeechResponse(text: string): Record<string, unknown> {
	return {
		type: "response.create",
		response: {
			conversation: "none",
			output_modalities: ["audio"],
			instructions: [
				"Read the supplied text aloud exactly as written.",
				"Do not answer, summarize, explain, translate, add greetings, add confirmations, or add sign-offs.",
				"If the text contains Markdown, render it naturally for speech while preserving the words and meaning.",
			].join(" "),
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: `Speak this exact canonical Zip response:\n\n${text}`,
						},
					],
				},
			],
		},
	};
}

export function handleRealtimeVoiceUpgrade(
	config: RealtimeVoiceBridgeConfig,
): (req: IncomingMessage, socket: Socket, head: Buffer) => void {
	const wss = new WebSocketServer({ noServer: true });
	return (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
			new RealtimeVoiceSession(ws, config).start();
		});
	};
}

class RealtimeVoiceSession {
	private readonly client: WebSocket;
	private readonly config: RealtimeVoiceBridgeConfig;
	private readonly adapter: RealtimeVoiceCanonicalAdapter;
	private openai: WebSocket | null = null;
	private voice = DEFAULT_VOICE;
	private outputActive = false;
	private outputCancelSent = false;
	private userSpeechActive = false;
	private assistantSpeechId: string | null = null;
	private eventboxUnsubscribe: (() => void) | null = null;
	private closed = false;

	constructor(client: WebSocket, config: RealtimeVoiceBridgeConfig) {
		this.client = client;
		this.config = config;
		this.adapter = new RealtimeVoiceCanonicalAdapter(this, config.workingDir);
	}

	start(): void {
		log.logInfo("[realtime-voice] local client connected");
		this.sendClient({ type: "connecting" });

		this.client.on("message", (data, isBinary) => {
			if (isBinary) {
				this.forwardAudio(data);
				return;
			}
			this.handleClientControl(data);
		});

		this.client.on("close", () => this.close());
		this.client.on("error", (err) => {
			log.logWarning("[realtime-voice] client socket error", err.message);
			this.close();
		});
		this.eventboxUnsubscribe = this.config.eventbox?.onEvent((event) => {
			this.handleEventboxEvent(event);
		}) ?? null;
	}

	isOutputActive(): boolean {
		return this.outputActive;
	}

	sendRuntimeStatus(message: string): void {
		const clean = cleanRuntimeStatus(message);
		if (clean) this.sendClient({ type: "thinking", message: clean });
	}

	speakCanonicalText(text: string): void {
		const clean = text.trim();
		if (!clean || !this.openai || this.openai.readyState !== WebSocket.OPEN) return;

		this.cancelOutput({ notifyClient: true });
		this.outputActive = true;
		this.outputCancelSent = false;
		this.assistantSpeechId = beginAssistantSpeech(clean);
		this.sendClient({ type: "assistant_text", text: clean });
		this.sendClient({ type: "speaking" });
		this.adapter.logBotResponse(REALTIME_CHANNEL_ID, clean, String(Date.now()));
		this.publishEventboxTurn("turn.assistant.final", { text: clean });
		this.sendOpenAI(createCanonicalSpeechResponse(clean));
	}

	emitContentBlock(block: { type: string; [key: string]: unknown }): void {
		switch (block.type) {
			case "toolCall": {
				const name = stringValue(block.name) || "tool";
				this.sendClient({ type: "thinking", message: `Using ${name}...` });
				break;
			}
			case "toolResult":
				this.sendClient({ type: "thinking", message: "Tool finished." });
				break;
			case "thinking":
				this.sendClient({ type: "thinking", message: "Zip is thinking..." });
				break;
			case "error":
				this.sendClient({ type: "error", message: stringValue(block.message) || "Runtime error" });
				break;
			default:
				break;
		}
	}

	private handleClientControl(data: WebSocket.RawData): void {
		let msg: RealtimeClientControl;
		try {
			msg = JSON.parse(rawDataToString(data)) as RealtimeClientControl;
		} catch {
			return;
		}

		if (msg.type === "start") {
			void this.handleStart(msg as RealtimeClientStart);
			return;
		}
		if (msg.type === "interrupt") {
			this.interrupt();
			return;
		}
		if (msg.type === "stop") {
			this.close();
			return;
		}
	}

	private async handleStart(msg: RealtimeClientStart): Promise<void> {
		this.voice = sanitizeVoice(msg.voice);
		let apiKey = "";
		try {
			apiKey = await realtimeApiKey(msg.apiKey, this.voice);
		} catch (err) {
			this.sendClient({
				type: "error",
				message: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		if (!apiKey) {
			this.sendClient({
				type: "error",
				message: "Missing Realtime 2 credentials. Sign in to TinyFat for brokered access or configure OPENAI_API_KEY locally.",
			});
			return;
		}
		this.connectOpenAI(apiKey);
	}

	private connectOpenAI(apiKey: string): void {
		this.openai?.close();
		const ws = new WebSocket(OPENAI_REALTIME_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});
		this.openai = ws;
		this.sendClient({ type: "connecting", message: "Connecting Realtime 2..." });

		ws.on("open", () => {
			log.logInfo("[realtime-voice] connected to OpenAI Realtime transport");
		});
		ws.on("message", (data) => this.handleOpenAIMessage(data));
		ws.on("close", () => {
			log.logInfo("[realtime-voice] OpenAI Realtime closed");
			this.finishOutput();
			this.sendClient({ type: "listening" });
		});
		ws.on("error", (err) => {
			log.logWarning("[realtime-voice] OpenAI socket error", err.message);
			this.sendClient({ type: "error", message: err.message });
		});
	}

	private handleOpenAIMessage(data: WebSocket.RawData): void {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(rawDataToString(data)) as Record<string, unknown>;
		} catch {
			return;
		}

		switch (event.type) {
			case "session.created":
				this.sendOpenAI(createRealtimeSessionUpdate({ voice: this.voice }));
				this.sendClient({ type: "connecting", message: "Configuring Realtime 2 transport..." });
				break;
			case "session.updated":
				this.sendClient({ type: "listening", message: "Realtime voice ready for Zip." });
				break;
			case "response.created":
				this.outputActive = true;
				this.outputCancelSent = false;
				this.sendClient({ type: "speaking" });
				break;
			case "input_audio_buffer.speech_started": {
				this.userSpeechActive = true;
				const wasOutputActive = this.outputActive;
				if (wasOutputActive) this.cancelOutput({ notifyClient: true });
				this.sendClient({ type: wasOutputActive ? "barge_in" : "transcribing" });
				break;
			}
			case "input_audio_buffer.speech_stopped":
			case "input_audio_buffer.committed":
				this.userSpeechActive = false;
				if (!this.outputActive) this.sendClient({ type: "thinking" });
				break;
			case "conversation.item.input_audio_transcription.delta":
				this.sendClient({ type: "partial", text: String(event.delta ?? "") });
				break;
			case "conversation.item.input_audio_transcription.completed":
				void this.handleInputTranscript(String(event.transcript ?? ""));
				break;
			case "conversation.item.input_audio_transcription.failed":
				this.sendClient({ type: "error", message: "Realtime transcription failed." });
				break;
			case "response.output_audio.delta":
			case "response.audio.delta":
				this.outputActive = true;
				this.sendClient({ type: "speaking" });
				this.sendAudioDelta(String(event.delta ?? ""));
				break;
			case "response.output_audio.done":
			case "response.audio.done":
				break;
			case "response.done":
				this.finishOutput();
				if (!this.userSpeechActive && !this.closed) {
					this.sendClient({ type: "listening", message: "Listening for Zip..." });
				}
				break;
			case "error":
				this.sendClient({ type: "error", message: openAIErrorMessage(event) });
				break;
			default:
				break;
		}
	}

	private async handleInputTranscript(transcript: string): Promise<void> {
		const text = transcript.trim();
		if (!text) return;
		this.sendClient({ type: "transcript", text });
		const suppression = shouldSuppressAssistantSpeechEcho(text);
		if (suppression.suppress) {
			log.logInfo(
				`[realtime-voice] Suppressed assistant speech echo: "${text}" ` +
				`(${suppression.reason}, similarity=${suppression.similarity?.toFixed(2) ?? "n/a"})`,
			);
			this.sendClient({ type: "transcript_ignored", reason: suppression.reason });
			return;
		}
		this.cancelOutput({ notifyClient: true });
		this.adapter.logInbound(text);
		this.publishEventboxTurn("turn.user.final", { text });
		await this.dispatchCanonicalUtterance(text);
	}

	private async dispatchCanonicalUtterance(text: string): Promise<void> {
		const event: MomEvent = {
			type: "dm",
			channel: REALTIME_CHANNEL_ID,
			ts: String(Date.now()),
			user: REALTIME_USER_ID,
			text,
			rawText: text,
			sourceEventType: "realtime_voice",
			directlyAddressed: true,
		};

		try {
			if (this.config.handler.resolvePendingInput(REALTIME_CHANNEL_ID, text)) return;

			if (text.trim().startsWith("/")) {
				const commandResult = await this.config.handler.handleSlashCommand(event, this.adapter);
				const pending = slashCommandPending(commandResult);
				if (pending) await pending;
				if (slashCommandHandled(commandResult)) return;
			}

			if (text.toLowerCase().trim() === "stop") {
				await this.config.handler.handleStop(REALTIME_CHANNEL_ID, this.adapter);
				return;
			}

			this.sendClient({ type: "thinking", message: "Zip is thinking..." });
			if (this.config.handler.isRunning(REALTIME_CHANNEL_ID)) {
				this.config.handler.handleSteer(event, this.adapter);
				return;
			}
			await this.config.handler.handleEvent(event, this.adapter);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.logWarning("[realtime-voice] canonical handler error", message);
			this.sendClient({ type: "error", message });
		}
	}

	private forwardAudio(data: WebSocket.RawData): void {
		if (!this.openai || this.openai.readyState !== WebSocket.OPEN) return;
		const buffer = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
		if (buffer.byteLength === 0) return;
		this.sendOpenAI({
			type: "input_audio_buffer.append",
			audio: buffer.toString("base64"),
		});
	}

	private interrupt(): void {
		this.sendOpenAI({ type: "input_audio_buffer.clear" });
		this.cancelOutput({ notifyClient: true });
		this.sendClient({ type: "listening", message: "Listening for Zip..." });
	}

	private cancelOutput(options: { notifyClient: boolean }): void {
		if (options.notifyClient) this.sendClient({ type: "interrupt_audio" });
		if (this.outputActive && !this.outputCancelSent) {
			this.outputCancelSent = true;
			this.sendOpenAI({ type: "response.cancel" });
		}
		this.finishOutput();
	}

	private finishOutput(): void {
		this.outputActive = false;
		this.outputCancelSent = false;
		if (this.assistantSpeechId) {
			finishAssistantSpeech(this.assistantSpeechId);
			this.assistantSpeechId = null;
		}
	}

	private handleEventboxEvent(event: LocalEventboxEvent): void {
		if (event.kind !== "cloud.inbound.observed") return;
		const payload = event.payload ?? {};
		this.sendClient({
			type: "cloud_event",
			eventId: event.event_id,
			message: displayCloudInbound(payload),
		});
	}

	private publishEventboxTurn(kind: string, payload: { text: string }): void {
		this.config.eventbox?.publish(kind, {
			channel: REALTIME_CHANNEL_ID,
			adapter: "realtime-voice",
			text: truncate(payload.text, 2000),
		});
	}

	private sendAudioDelta(base64: string): void {
		if (!base64 || this.client.readyState !== WebSocket.OPEN) return;
		const audio = Buffer.from(base64, "base64");
		if (audio.byteLength > 0) this.client.send(audio);
	}

	private sendOpenAI(event: Record<string, unknown>): void {
		if (!this.openai || this.openai.readyState !== WebSocket.OPEN) return;
		this.openai.send(JSON.stringify(event));
	}

	private sendClient(event: Record<string, unknown>): void {
		if (this.client.readyState === WebSocket.OPEN) {
			this.client.send(JSON.stringify(event));
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.eventboxUnsubscribe?.();
		this.eventboxUnsubscribe = null;
		this.finishOutput();
		this.openai?.close();
		this.openai = null;
		if (this.client.readyState === WebSocket.OPEN) {
			this.client.close();
		}
	}
}

class RealtimeVoiceCanonicalAdapter implements PlatformAdapter {
	readonly name = "realtime-voice";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Realtime Voice
You are responding through a live voice interface. Keep responses concise, natural, and spoken-friendly.
Do not use raw Markdown formatting, long tables, or huge code blocks unless Alex explicitly asks.
This is the canonical Zip runtime: use your normal memory, tools, workspace, and channel awareness.`;

	private readonly session: RealtimeVoiceSession;
	private readonly workingDir: string;
	private readonly users = new Map<string, UserInfo>();

	constructor(session: RealtimeVoiceSession, workingDir: string) {
		this.session = session;
		this.workingDir = workingDir;
		this.users.set(REALTIME_USER_ID, {
			id: REALTIME_USER_ID,
			userName: REALTIME_USER_NAME,
			displayName: REALTIME_USER_NAME,
		});
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	dispatch = undefined;

	logInbound(text: string): void {
		this.logToFile({
			date: new Date().toISOString(),
			ts: String(Date.now()),
			channel: "realtime:voice",
			channelId: REALTIME_CHANNEL_ID,
			user: REALTIME_USER_ID,
			userName: REALTIME_USER_NAME,
			text,
			attachments: [],
			isBot: false,
			adapter: this.name,
		});
	}

	async postMessage(_channel: string, text: string): Promise<string> {
		this.session.speakCanonicalText(text);
		return String(Date.now());
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string): Promise<void> {}
	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> { return String(Date.now()); }
	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	logToFile(entry: object): void {
		try {
			appendFileSync(join(this.workingDir, "log.jsonl"), JSON.stringify(entry) + "\n");
		} catch {
			// Logging must not break live voice.
		}
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			date: new Date().toISOString(),
			ts,
			channel: `realtime:${channel}`,
			channelId: channel,
			user: "zip",
			text,
			attachments: [],
			isBot: true,
			adapter: this.name,
		});
	}

	getUser(userId: string): UserInfo | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		return channelId === REALTIME_CHANNEL_ID ? { id: REALTIME_CHANNEL_ID, name: REALTIME_CHANNEL_NAME } : undefined;
	}

	getAllUsers(): UserInfo[] { return Array.from(this.users.values()); }
	getAllChannels(): ChannelInfo[] { return [{ id: REALTIME_CHANNEL_ID, name: REALTIME_CHANNEL_NAME }]; }

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.rawText ?? event.text,
				user: event.user,
				userName: REALTIME_USER_NAME,
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
			channelName: REALTIME_CHANNEL_NAME,
			channels: this.getAllChannels(),
			users: this.getAllUsers(),
			respond: async (text: string, shouldLog = true) => {
				if (!shouldLog) this.session.sendRuntimeStatus(text);
			},
			sendFinalResponse: async (text: string) => {
				this.session.speakCanonicalText(text);
			},
			respondInThread: async (_text: string) => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async (working: boolean) => {
				if (working) {
					this.session.sendRuntimeStatus("Zip is thinking...");
				} else if (!this.session.isOutputActive()) {
					this.session.sendRuntimeStatus("Listening for Zip...");
				}
			},
			deleteMessage: async () => {},
			restartWorking: async () => {
				this.session.sendRuntimeStatus("Updating Zip's run...");
			},
			emitContentBlock: (block) => this.session.emitContentBlock(block),
		};
	}

	enqueueEvent(_event: MomEvent): boolean {
		return false;
	}
}

function cleanRuntimeStatus(text: string): string {
	return text
		.replace(/^_+|_+$/g, "")
		.replace(/^→\s*/, "Using ")
		.trim();
}

function rawDataToString(data: WebSocket.RawData): string {
	if (typeof data === "string") return data;
	if (data instanceof Buffer) return data.toString("utf-8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
	return Buffer.from(new Uint8Array(data as ArrayBuffer)).toString("utf-8");
}

function sanitizeVoice(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_VOICE;
	const normalized = value.trim().toLowerCase();
	return /^[a-z][a-z0-9_-]{1,32}$/.test(normalized) ? normalized : DEFAULT_VOICE;
}

function usableRealtimeKey(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (trimmed === OPENAI_PLACEHOLDER_KEY || trimmed.includes("placeholder")) return undefined;
	return trimmed;
}

async function realtimeApiKey(clientApiKey: string | undefined, voice: string): Promise<string> {
	const localKey = [
		usableRealtimeKey(process.env.OPENAI_API_KEY),
		usableRealtimeKey(process.env.MOM_OPENAI_API_KEY),
		usableRealtimeKey(clientApiKey),
	].find((value): value is string => Boolean(value));
	if (localKey) return localKey;
	return fetchRealtimeClientSecret(voice);
}

async function fetchRealtimeClientSecret(voice: string): Promise<string> {
	const baseUrl = process.env.TROUBLEMAKER_CLOUD_BASE_URL?.trim();
	const agentId = process.env.TROUBLEMAKER_CLOUD_AGENT_ID?.trim();
	const accessToken = process.env.TROUBLEMAKER_CLOUD_ACCESS_TOKEN?.trim();
	if (!baseUrl || !agentId || !accessToken) return "";

	const url = new URL(`/api/v2/agents/${agentId}/realtime/client-secret`, baseUrl);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			voice,
			ttl_seconds: 600,
		}),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Realtime broker failed (${response.status}): ${extractBrokerError(text)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Realtime broker returned invalid JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Realtime broker returned an invalid client secret payload.");
	}
	const value = (parsed as Record<string, unknown>).value;
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("Realtime broker response did not include a client secret value.");
	}
	log.logInfo("[realtime-voice] using brokered OpenAI Realtime client secret");
	return value.trim();
}

function extractBrokerError(text: string): string {
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		const message = parsed.error_description ?? parsed.error ?? text;
		return typeof message === "string" ? truncate(message, 500) : truncate(text, 500);
	} catch {
		return truncate(text, 500);
	}
}

function displayCloudInbound(payload: Record<string, unknown>): string {
	return stringValue(payload.summary)
		|| stringValue(payload.text)
		|| `${stringValue(payload.platform) || stringValue(payload.route) || "Cloud"} inbound event observed.`;
}

function stringValue(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function openAIErrorMessage(event: Record<string, unknown>): string {
	const error = event.error;
	if (error && typeof error === "object" && !Array.isArray(error)) {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === "string" && message.trim()) return message.trim();
	}
	const message = event.message;
	return typeof message === "string" && message.trim() ? message.trim() : "Realtime error";
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 32)}\n[truncated ${text.length - maxChars + 32} chars]`;
}
