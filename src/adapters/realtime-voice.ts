import { appendFileSync } from "fs";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { join } from "path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import WebSocket, { WebSocketServer } from "ws";
import * as log from "../log.js";
import type { LocalEventboxClient, LocalEventboxEvent } from "../local/eventbox-client.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2";
const REALTIME_MODEL = "gpt-realtime-2";
const TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const DEFAULT_VOICE = "marin";
const REALTIME_AGENT_NAME = "Zip";
const MAX_TOOL_OUTPUT_CHARS = 12000;

export interface RealtimeVoiceBridgeConfig {
	workingDir: string;
	tools: () => AgentTool<any>[];
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
		"You are Zip, Alex's Troublemaker realtime voice agent running on this Mac. The user is speaking directly to you.",
		"Answer the user's request; do not repeat, read back, or transcribe their words unless they explicitly ask you to.",
		"You have tools for reading/editing/writing files, running bash commands, inspecting channels and Slack threads, sending user-visible messages, and querying compact Zip context.",
		"Use get_context_briefing for cheap Zip orientation and search_context for specific past-chat lookup. Do not load full awareness/context files unless the user explicitly needs raw records.",
		"Cloud inbound awareness may arrive while this realtime session is active. It is context only, already routed through the normal cloud delivery path; mention it aloud only if useful, and do not send a channel reply unless Alex explicitly asks you to.",
		"Use tools when files, actions, or channel/thread routing are needed. Do not claim you lack Zip/Troublemaker context before checking the relevant tools.",
		"Keep spoken responses concise and natural. When a tool result is long, summarize the useful outcome.",
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

export function createRealtimeFunctionTools(tools: AgentTool<any>[]): Record<string, unknown>[] {
	return tools
		.filter((tool) => tool.name !== "speak")
		.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: cloneJsonSchema(tool.parameters),
		}));
}

export function createRealtimeSessionUpdate(
	options: { voice?: string; tools: AgentTool<any>[] },
): Record<string, unknown> {
	return {
		type: "session.update",
		session: {
			type: "realtime",
			model: REALTIME_MODEL,
			output_modalities: ["audio"],
			instructions: createRealtimeVoiceInstructions(),
			reasoning: { effort: "low" },
			tools: createRealtimeFunctionTools(options.tools),
			tool_choice: "auto",
			parallel_tool_calls: false,
			audio: createRealtimeAudioConfig(options.voice ?? DEFAULT_VOICE),
		},
	};
}

export function formatRealtimeToolResult(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const item of result.content ?? []) {
		if (item.type === "text" && item.text.trim()) {
			parts.push(item.text);
		} else if (item.type === "image") {
			parts.push(`[image ${item.mimeType || "unknown"} omitted from voice tool output]`);
		}
	}
	if (result.details !== undefined) {
		const details = safeJson(result.details);
		if (details) parts.push(`Details: ${details}`);
	}
	const text = parts.join("\n").trim() || "Tool completed.";
	return truncate(text, MAX_TOOL_OUTPUT_CHARS);
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
	private openai: WebSocket | null = null;
	private voice = DEFAULT_VOICE;
	private agentName = REALTIME_AGENT_NAME;
	private responseActive = false;
	private responseCancelSent = false;
	private handledFunctionCallIds = new Set<string>();
	private handledEventboxEventIds = new Set<string>();
	private currentAssistantText = "";
	private userSpeechActive = false;
	private pendingEventboxResponse = false;
	private eventboxUnsubscribe: (() => void) | null = null;

	constructor(client: WebSocket, config: RealtimeVoiceBridgeConfig) {
		this.client = client;
		this.config = config;
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
			log.logInfo("[realtime-voice] connected to OpenAI Realtime");
		});
		ws.on("message", (data) => this.handleOpenAIMessage(data));
		ws.on("close", () => {
			log.logInfo("[realtime-voice] OpenAI Realtime closed");
			this.sendClient({ type: "listening" });
		});
		ws.on("error", (err) => {
			log.logWarning("[realtime-voice] OpenAI socket error", err.message);
			this.sendClient({ type: "error", message: err.message });
		});
	}

	private handleOpenAIMessage(data: WebSocket.RawData): void {
		let event: Record<string, any>;
		try {
			event = JSON.parse(rawDataToString(data)) as Record<string, any>;
		} catch {
			return;
		}

		switch (event.type) {
			case "session.created":
				this.sendOpenAI(createRealtimeSessionUpdate({
					voice: this.voice,
					tools: this.config.tools(),
				}));
				this.sendClient({ type: "connecting", message: "Configuring Realtime 2..." });
				break;
			case "session.updated":
				this.sendClient({ type: "listening", message: "Realtime 2 ready." });
				break;
			case "response.created":
				this.responseActive = true;
				this.responseCancelSent = false;
				this.currentAssistantText = "";
				break;
			case "input_audio_buffer.speech_started":
				this.userSpeechActive = true;
				this.sendClient({ type: this.responseActive ? "barge_in" : "transcribing" });
				break;
			case "input_audio_buffer.speech_stopped":
				this.userSpeechActive = false;
				if (this.pendingEventboxResponse && !this.responseActive) this.sendResponseCreate();
				break;
			case "input_audio_buffer.committed":
				this.userSpeechActive = false;
				if (!this.responseActive) this.sendClient({ type: "thinking" });
				break;
			case "conversation.item.input_audio_transcription.delta":
				this.sendClient({ type: "partial", text: String(event.delta ?? "") });
				break;
			case "conversation.item.input_audio_transcription.completed":
				this.handleInputTranscript(String(event.transcript ?? ""));
				break;
			case "conversation.item.input_audio_transcription.failed":
				if (!this.responseActive) this.sendResponseCreate();
				break;
			case "response.output_text.delta":
			case "response.audio_transcript.delta":
			case "response.output_audio_transcript.delta":
				this.responseActive = true;
				this.currentAssistantText += String(event.delta ?? "");
				this.sendClient({ type: "assistant_text_delta", text: String(event.delta ?? "") });
				this.sendClient({ type: "speaking" });
				break;
			case "response.output_text.done":
			case "response.output_audio_transcript.done": {
				const finalText = String(event.text ?? event.transcript ?? "");
				if (finalText) this.currentAssistantText = finalText;
				this.sendClient({ type: "assistant_text", text: finalText });
				break;
			}
			case "response.output_audio.delta":
			case "response.audio.delta":
				this.responseActive = true;
				this.sendClient({ type: "speaking" });
				this.sendAudioDelta(String(event.delta ?? ""));
				break;
			case "response.output_item.done":
				if (event.item?.type === "function_call") {
					void this.handleFunctionCall(event.item);
				}
				break;
			case "response.output_audio.done":
			case "response.audio.done":
				break;
			case "response.done":
				this.handleResponseDone(event);
				break;
			case "error":
				this.sendClient({ type: "error", message: event.error?.message || event.message || "Realtime error" });
				break;
			default:
				break;
		}
	}

	private handleInputTranscript(transcript: string): void {
		const text = transcript.trim();
		if (!text) return;
		this.sendClient({ type: "transcript", text });
		this.logVoiceLine({ text, isBot: false });
		this.publishEventboxTurn("turn.user.final", { text });
		if (this.responseActive) {
			this.responseCancelSent = true;
			this.sendClient({ type: "interrupt_audio" });
			this.sendOpenAI({ type: "response.cancel" });
		}
		this.sendResponseCreate();
	}

	private handleResponseDone(event: Record<string, any>): void {
		const output = event.response?.output;
		if (Array.isArray(output)) {
			for (const item of output) {
				if (item?.type === "function_call") {
					void this.handleFunctionCall(item);
				}
			}
		}
		this.responseActive = false;
		this.responseCancelSent = false;
		const assistantText = this.currentAssistantText.trim();
		if (assistantText) {
			this.logVoiceLine({ text: assistantText, isBot: true });
			this.publishEventboxTurn("turn.assistant.final", { text: assistantText });
		}
		if (this.pendingEventboxResponse && !this.userSpeechActive) {
			this.sendResponseCreate();
			return;
		}
		this.sendClient({ type: "listening", message: "Listening with Realtime 2..." });
	}

	private async handleFunctionCall(item: Record<string, any>): Promise<void> {
		const callId = String(item.call_id ?? "");
		const name = String(item.name ?? "");
		if (!callId || !name || this.handledFunctionCallIds.has(callId)) return;
		this.handledFunctionCallIds.add(callId);
		this.sendClient({ type: "thinking", message: `Using ${name}...` });

		const output = await this.executeTool(name, parseArguments(item.arguments));
		this.sendOpenAI({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: callId,
				output,
			},
		});
		this.sendResponseCreate();
	}

	private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
		const tool = this.config.tools().find((candidate) => candidate.name === name);
		if (!tool) {
			return `Tool error: Tool not available: ${name}`;
		}

		const toolArgs = { ...args };
		if (typeof toolArgs.label !== "string" || !toolArgs.label.trim()) {
			toolArgs.label = `Realtime ${name}`;
		}

		try {
			const prepared = tool.prepareArguments ? tool.prepareArguments(toolArgs) : toolArgs;
			const result = await tool.execute(`realtime-${Date.now()}-${name}`, prepared as any);
			return formatRealtimeToolResult(result);
		} catch (error) {
			return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
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
		this.sendClient({ type: "interrupt_audio" });
		if (this.responseActive && !this.responseCancelSent) {
			this.responseCancelSent = true;
			this.sendOpenAI({ type: "response.cancel" });
		}
		this.sendClient({ type: "listening", message: "Listening with Realtime 2..." });
	}

	private sendResponseCreate(): void {
		this.pendingEventboxResponse = false;
		this.sendClient({ type: "thinking", message: "Realtime 2 is thinking..." });
		this.sendOpenAI({ type: "response.create" });
	}

	private handleEventboxEvent(event: LocalEventboxEvent): void {
		if (event.kind !== "cloud.inbound.observed") return;
		const eventId = event.event_id?.trim() || `${event.kind}:${event.seq ?? ""}:${event.created_at ?? ""}`;
		if (this.handledEventboxEventIds.has(eventId)) return;
		this.handledEventboxEventIds.add(eventId);
		const payload = event.payload ?? {};
		this.sendClient({
			type: "cloud_event",
			eventId,
			message: displayCloudInbound(payload),
		});
		const context = formatCloudInboundContext(payload);
		if (!context || !this.openai || this.openai.readyState !== WebSocket.OPEN) return;
		this.sendOpenAI({
			event_id: `eventbox_context_${sanitizeEventId(eventId)}`,
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: context,
					},
				],
			},
		});
		if (this.responseActive || this.userSpeechActive) {
			this.pendingEventboxResponse = true;
			return;
		}
		this.sendResponseCreate();
	}

	private publishEventboxTurn(kind: string, payload: { text: string }): void {
		this.config.eventbox?.publish(kind, {
			channel: "mac-realtime",
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

	private logVoiceLine(entry: { text: string; isBot: boolean }): void {
		try {
			appendFileSync(join(this.config.workingDir, "log.jsonl"), JSON.stringify({
				date: new Date().toISOString(),
				ts: String(Date.now()),
				channel: "realtime:voice",
				channelId: "mac-realtime",
				user: entry.isBot ? "zip" : "mac-user",
				displayName: entry.isBot ? this.agentName : "Mac user",
				text: truncate(entry.text, 500),
				isBot: entry.isBot,
				adapter: "realtime-voice",
			}) + "\n");
		} catch {
			// Logging must not break a live voice turn.
		}
	}

	private close(): void {
		this.eventboxUnsubscribe?.();
		this.eventboxUnsubscribe = null;
		this.openai?.close();
		this.openai = null;
		if (this.client.readyState === WebSocket.OPEN) {
			this.client.close();
		}
	}
}

function cloneJsonSchema(schema: unknown): Record<string, unknown> {
	if (!schema || typeof schema !== "object") {
		return { type: "object", properties: {}, required: [] };
	}
	return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function parseArguments(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || !raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through.
	}
	return {};
}

function safeJson(value: unknown): string | null {
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
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

async function realtimeApiKey(clientApiKey: string | undefined, voice: string): Promise<string> {
	const localKey = [
		process.env.OPENAI_API_KEY,
		process.env.MOM_OPENAI_API_KEY,
		clientApiKey,
	]
		.map((value) => value?.trim())
		.find((value): value is string => Boolean(value));
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

function formatCloudInboundContext(payload: Record<string, unknown>): string {
	const summary = stringValue(payload.summary);
	const platform = stringValue(payload.platform) || stringValue(payload.route) || "cloud";
	const text = stringValue(payload.text);
	const sender = stringValue(payload.sender_name) || stringValue(payload.sender_id) || stringValue(payload.from);
	const location = stringValue(payload.channel_id)
		|| stringValue(payload.chat_name)
		|| stringValue(payload.chat_id)
		|| stringValue(payload.subject)
		|| stringValue(payload.conversation_id);
	if (!summary && !text) return "";
	return [
		"[Cloud inbound awareness]",
		"This is context for the active Mac realtime session, not a new utterance from Alex.",
		"The message is already on the normal Crawdad queue/container delivery path. Do not treat this as a second adapter delivery, and do not send a channel reply unless Alex explicitly asks.",
		`Source: ${platform}${location ? ` / ${location}` : ""}${sender ? ` / from ${sender}` : ""}`,
		summary ? `Summary: ${summary}` : "",
		text ? `Message text: ${truncate(text, 1400)}` : "",
		"If this seems useful to Alex right now, briefly mention it aloud. If it is routine or irrelevant, keep it in mind silently.",
	].filter(Boolean).join("\n");
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

function sanitizeEventId(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || String(Date.now());
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 32)}\n[truncated ${text.length - maxChars + 32} chars]`;
}
