import { appendFileSync } from "fs";
import type { IncomingMessage } from "http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "net";
import { join } from "path";
import WebSocket, { WebSocketServer } from "ws";
import {
	beginAssistantSpeech,
	finishAssistantSpeech,
	shouldSuppressAssistantSpeechEcho,
} from "../audio-feedback-guard.js";
import * as log from "../log.js";
import {
	DEFAULT_REALTIME_VOICE,
	normalizeRealtimeVoiceName,
} from "../realtime-voices.js";
import type { ChannelStore } from "../store.js";
import type { LocalEventboxClient, LocalEventboxEvent } from "../local/eventbox-client.js";
import { FilesystemWorkspaceStore } from "../storage/node/filesystem-workspace.js";
import { readConfiguredRealtimeVoice } from "../voice-contract.js";
import {
	type ChannelInfo,
	type MomContext,
	type MomEvent,
	type MomHandler,
	type PlatformAdapter,
	type UserInfo,
	type VoiceSessionNotice,
} from "./types.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";
const REALTIME_MODEL = "gpt-realtime-2";
const TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const REALTIME_CHANNEL_ID = "mac-realtime";
const REALTIME_CHANNEL_NAME = "realtime voice";
const REALTIME_USER_ID = "mac-user";
const REALTIME_USER_NAME = "voice-user";
const OPENAI_PLACEHOLDER_KEY = "sk-tfat-egress-openai-placeholder";

export interface RealtimeVoiceBridgeConfig {
	workingDir: string;
	handler: MomHandler;
	eventbox?: LocalEventboxClient;
	localControlToken?: string;
}

export type RealtimeAuthSource = "broker" | "local" | "client" | "none";

export interface RealtimeAuthPlan {
	source: RealtimeAuthSource;
	key?: string;
	reason?: string;
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

export function createRealtimeAudioConfig(voice = DEFAULT_REALTIME_VOICE): Record<string, unknown> {
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
			audio: createRealtimeAudioConfig(options.voice ?? DEFAULT_REALTIME_VOICE),
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
							text: `Speak this exact canonical agent response:\n\n${text}`,
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
		if (!isRealtimeControlTokenAccepted(config.localControlToken, realtimeControlTokenFromRequest(req))) {
			log.logWarning("[realtime-voice] rejected local client with missing or invalid control token");
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
			new RealtimeVoiceSession(ws, config).start();
		});
	};
}

export class RealtimeVoiceSession {
	private readonly client: WebSocket;
	private readonly config: RealtimeVoiceBridgeConfig;
	private readonly adapter: RealtimeVoiceCanonicalAdapter;
	private openai: WebSocket | null = null;
	private openaiReady = false;
	private voice = DEFAULT_REALTIME_VOICE;
	private readonly sessionId = randomUUID();
	private outputEnabled = false;
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
		if (!this.outputEnabled || !clean || !this.openai || this.openai.readyState !== WebSocket.OPEN || !this.openaiReady) return;

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
				this.sendClient({ type: "thinking", message: "The agent is thinking..." });
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
		const workspace = new FilesystemWorkspaceStore(this.config.workingDir);
		this.voice = readConfiguredRealtimeVoice(workspace)
			?? normalizeRealtimeVoiceName(msg.voice)
			?? DEFAULT_REALTIME_VOICE;
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
				message: "Missing Realtime 2 credentials. Sign in to TinyFat for brokered access or explicitly configure local Realtime credentials.",
			});
			return;
		}
		this.connectOpenAI(apiKey);
	}

	private connectOpenAI(apiKey: string): void {
		this.openai?.close();
		this.openaiReady = false;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
		};
		const safetyIdentifier = realtimeSafetyIdentifier(process.env);
		if (safetyIdentifier) {
			headers["OpenAI-Safety-Identifier"] = safetyIdentifier;
		}
		const ws = new WebSocket(OPENAI_REALTIME_URL, {
			headers,
		});
		this.openai = ws;
		this.sendClient({ type: "connecting", message: "Connecting Realtime 2..." });

		ws.on("open", () => {
			log.logInfo("[realtime-voice] connected to OpenAI Realtime transport");
		});
		ws.on("message", (data) => this.handleOpenAIMessage(data));
		ws.on("close", () => {
			log.logInfo("[realtime-voice] OpenAI Realtime closed");
			this.openaiReady = false;
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
				this.openaiReady = true;
				this.sendClient({ type: "listening", message: "Realtime voice ready; waiting for the wake phrase." });
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
					this.sendClient({ type: "listening", message: "Listening..." });
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
		this.dispatchCanonicalUtterance(text);
	}

	private dispatchCanonicalUtterance(text: string): void {
		const event: MomEvent = {
			type: "dm",
			channel: REALTIME_CHANNEL_ID,
			ts: String(Date.now()),
			user: REALTIME_USER_ID,
			text,
			rawText: text,
			sessionId: this.sessionId,
			sourceEventType: "realtime_voice",
		};

		if (!this.config.handler.handleVoiceEvent) {
			log.logWarning("[realtime-voice] Resident handler does not provide the explicit voice contract");
			this.sendClient({ type: "error", message: "Voice contract unavailable" });
			return;
		}
		this.config.handler.handleVoiceEvent(event, this.adapter);
	}

	private forwardAudio(data: WebSocket.RawData): void {
		if (!this.openai || this.openai.readyState !== WebSocket.OPEN || !this.openaiReady) return;
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
		this.sendClient({ type: "listening", message: "Listening..." });
	}

	interruptAssistantAudio(): void {
		this.cancelOutput({ notifyClient: true });
	}

	setVoiceSessionOpen(open: boolean): void {
		this.outputEnabled = open;
	}

	applyRealtimeVoice(voice: string): void {
		const normalized = normalizeRealtimeVoiceName(voice);
		if (!normalized) return;
		this.voice = normalized;
		if (this.openaiReady) this.sendOpenAI(createRealtimeSessionUpdate({ voice: normalized }));
	}

	recordCanonicalInput(text: string): void {
		this.adapter.logInbound(text);
		this.publishEventboxTurn("turn.user.final", { text });
	}

	sendVoiceControl(event: Record<string, unknown>): void {
		this.sendClient(event);
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
		this.config.handler.closeVoiceSession?.(this.sessionId, this.adapter);
		this.eventboxUnsubscribe?.();
		this.eventboxUnsubscribe = null;
		this.finishOutput();
		this.openai?.close();
		this.openai = null;
		this.openaiReady = false;
		if (this.client.readyState === WebSocket.OPEN) {
			this.client.close();
		}
	}
}

export class RealtimeVoiceCanonicalAdapter implements PlatformAdapter {
	readonly name = "realtime-voice";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Realtime Voice
You are responding through a live voice interface. Keep responses concise, natural, and spoken-friendly.
Do not use raw Markdown formatting, long tables, or huge code blocks unless the user explicitly asks.
This is the canonical agent runtime: use your normal memory, tools, workspace, and channel awareness.`;

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

	interruptOutputAudio(_event: MomEvent): void {
		this.session.interruptAssistantAudio();
	}

	handleVoiceSessionNotice(event: MomEvent, notice: VoiceSessionNotice): void {
		switch (notice.type) {
			case "session_opened":
				this.session.setVoiceSessionOpen(true);
				this.session.sendVoiceControl({ type: "voice_session_open", wake_name: notice.wakeName });
				this.session.sendVoiceControl({ type: "listening" });
				break;
			case "session_closed":
				this.session.setVoiceSessionOpen(false);
				this.session.sendVoiceControl({ type: "voice_session_closed" });
				this.session.sendVoiceControl({ type: "listening" });
				break;
			case "wake_required":
				this.session.sendVoiceControl({ type: "wake_required", reason: notice.reason });
				this.session.sendVoiceControl({ type: "listening" });
				break;
			case "voice_changed":
				this.session.sendVoiceControl({ type: "voice_changed", voice: notice.voice });
				this.session.sendVoiceControl({ type: "listening" });
				break;
			case "voice_change_rejected":
				this.session.sendVoiceControl({ type: "voice_change_rejected", reason: notice.reason });
				this.session.sendVoiceControl({ type: "listening" });
				break;
			case "turn_queued":
				this.session.recordCanonicalInput(event.text);
				this.session.sendVoiceControl({ type: "thinking", message: "The agent is thinking...", queue_position: notice.position });
				break;
		}
	}

	applyRealtimeVoice(_event: MomEvent, voice: string): void {
		this.session.applyRealtimeVoice(voice);
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
			user: "agent",
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
				sessionId: event.sessionId,
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
					this.session.sendRuntimeStatus("The agent is thinking...");
				} else if (!this.session.isOutputActive()) {
					this.session.sendRuntimeStatus("Listening...");
				}
			},
			deleteMessage: async () => {},
			restartWorking: async () => {
				this.session.sendRuntimeStatus("Updating the agent run...");
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

function realtimeControlTokenFromRequest(req: IncomingMessage): string | undefined {
	return headerString(req.headers["x-tinyfat-local-control"]);
}

export function isRealtimeControlTokenAccepted(expected: string | undefined, provided: string | undefined): boolean {
	const cleanExpected = stringValue(expected);
	if (!cleanExpected || Buffer.byteLength(cleanExpected, "utf-8") < 32) return false;
	const cleanProvided = stringValue(provided);
	if (!cleanProvided) return false;
	const expectedBytes = Buffer.from(cleanExpected, "utf-8");
	const providedBytes = Buffer.from(cleanProvided, "utf-8");
	return expectedBytes.byteLength === providedBytes.byteLength && timingSafeEqual(expectedBytes, providedBytes);
}

function headerString(value: unknown): string {
	if (Array.isArray(value)) return stringValue(value[0]);
	return stringValue(value);
}

function rawDataToString(data: WebSocket.RawData): string {
	if (typeof data === "string") return data;
	if (data instanceof Buffer) return data.toString("utf-8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
	return Buffer.from(new Uint8Array(data as ArrayBuffer)).toString("utf-8");
}

function usableRealtimeKey(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (trimmed === OPENAI_PLACEHOLDER_KEY || trimmed.includes("placeholder")) return undefined;
	return trimmed;
}

async function realtimeApiKey(clientApiKey: string | undefined, voice: string): Promise<string> {
	const plan = resolveRealtimeAuthPlan({ clientApiKey });
	switch (plan.source) {
		case "broker":
			return fetchRealtimeClientSecret(voice);
		case "local":
		case "client":
			return plan.key ?? "";
		case "none":
			if (plan.reason) throw new Error(plan.reason);
			return "";
	}
	return "";
}

async function fetchRealtimeClientSecret(voice: string): Promise<string> {
	const baseUrl = process.env.TROUBLEMAKER_CLOUD_BASE_URL?.trim();
	const agentId = process.env.TROUBLEMAKER_CLOUD_AGENT_ID?.trim();
	const accessToken = process.env.TROUBLEMAKER_CLOUD_ACCESS_TOKEN?.trim();
	if (!baseUrl || !agentId || !accessToken) return "";

	const url = new URL(`/api/v2/agents/${agentId}/realtime/client-secret`, baseUrl);
	const body: Record<string, unknown> = {
		voice,
		ttl_seconds: 600,
	};
	const safetyIdentifier = realtimeSafetyIdentifier(process.env);
	if (safetyIdentifier) {
		body.safety_identifier = safetyIdentifier;
	}
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
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

export function resolveRealtimeAuthPlan(options: { env?: Record<string, string | undefined>; clientApiKey?: string } = {}): RealtimeAuthPlan {
	const env = options.env ?? process.env;
	const mode = stringValue(env.TROUBLEMAKER_REALTIME_AUTH).toLowerCase();
	const brokerConfig = {
		baseUrl: stringValue(env.TROUBLEMAKER_CLOUD_BASE_URL),
		agentId: stringValue(env.TROUBLEMAKER_CLOUD_AGENT_ID),
		accessToken: stringValue(env.TROUBLEMAKER_CLOUD_ACCESS_TOKEN),
	};
	const brokerConfigured = Boolean(brokerConfig.baseUrl && brokerConfig.agentId && brokerConfig.accessToken);
	const cloudMarked = Boolean(brokerConfig.agentId || brokerConfig.accessToken);
	const localKey = [
		usableRealtimeKey(env.OPENAI_API_KEY),
		usableRealtimeKey(env.MOM_OPENAI_API_KEY),
	].find((value): value is string => Boolean(value));
	const clientKey = usableRealtimeKey(options.clientApiKey);

	if (mode === "none" || mode === "disabled") {
		return { source: "none", reason: "Realtime credentials disabled by TROUBLEMAKER_REALTIME_AUTH." };
	}

	if (mode === "broker" || mode === "cloud" || mode === "managed" || (cloudMarked && mode !== "local" && mode !== "direct")) {
		if (brokerConfigured) return { source: "broker" };
		return {
			source: "none",
			reason: "Realtime broker is selected, but TROUBLEMAKER_CLOUD_BASE_URL, TROUBLEMAKER_CLOUD_AGENT_ID, or TROUBLEMAKER_CLOUD_ACCESS_TOKEN is missing.",
		};
	}

	if ((mode === "client" || mode === "client-key") && clientKey) {
		return { source: "client", key: clientKey };
	}

	if (mode === "client" || mode === "client-key") {
		return { source: "none", reason: "Realtime client-key mode selected, but no client Realtime key was provided." };
	}

	if (localKey) return { source: "local", key: localKey };

	if (clientKey && truthy(env.TROUBLEMAKER_ALLOW_CLIENT_REALTIME_KEY)) {
		return { source: "client", key: clientKey };
	}

	if (clientKey) {
		return {
			source: "none",
			reason: "Client-supplied Realtime API keys are disabled. Sign in to TinyFat or set TROUBLEMAKER_ALLOW_CLIENT_REALTIME_KEY=1 for local testing.",
		};
	}

	return {
		source: "none",
		reason: "Missing Realtime 2 credentials. Sign in to TinyFat for brokered access or set TROUBLEMAKER_REALTIME_AUTH=local with OPENAI_API_KEY.",
	};
}

export function realtimeSafetyIdentifier(env: Record<string, string | undefined> = process.env): string {
	const parts = [
		stringValue(env.TROUBLEMAKER_CLOUD_AGENT_ID),
		stringValue(env.TROUBLEMAKER_LOCAL_AGENT_ID),
		stringValue(env.TROUBLEMAKER_AGENT_PROFILE),
		stringValue(env.TROUBLEMAKER_TENANT_ID),
	].filter(Boolean);
	if (parts.length === 0) return "";
	const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
	return `tfat:${digest.slice(0, 48)}`;
}

function truthy(value: string | undefined): boolean {
	switch (stringValue(value).toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
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
