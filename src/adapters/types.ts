import type { IncomingMessage, ServerResponse } from "http";
import type { ToolStreamingMode, WorkingOutputTarget, WorkingStreamPresentation } from "../context.js";
import type { Attachment, ChannelStore } from "../store.js";
import type {
	RelationshipAdmissionRequest,
	RelationshipAdmissionResult,
} from "../relationship-bound-admission.js";

// ============================================================================
// Platform-agnostic types for mom adapters
// ============================================================================

/**
 * An incoming message event from any platform.
 * Adapters translate platform-specific events into this shape.
 */
export interface FollowUpWakeMetadata {
	key: string;
	generation: string;
	ordinal: number;
}

export interface MomEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	/** Slack workspace associated with the invoking user, when supplied by Slack. */
	teamId?: string;
	text: string;
	rawText?: string;
	/** Start this event from a freshly archived Pi session context. */
	freshContext?: boolean;
	/** Client-scoped conversational session id, when the transport has one. */
	sessionId?: string;
	sourceEventType?: string;
	/** Internal prompt projection selected only by a trusted adapter. */
	contextProjection?: "concise_watch";
	/** Stable opaque transport identity used only for exact delivery/run reconciliation. */
	deliveryId?: string;
	/** Trusted relationship identity supplied only by an authenticated ingress. */
	relationshipId?: string;
	directlyAddressed?: boolean;
	threadTs?: string;
	replyTarget?: string;
	replyTargetDescription?: string;
	/** Present only on harness-generated idle follow-up checks. */
	followUp?: FollowUpWakeMetadata;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** Processed attachments with local paths (populated after logging) */
	attachments?: Attachment[];
}

export type VoiceSessionNotice =
	| { type: "wake_required"; reason: "wake_phrase_missing" | "wake_name_unconfigured" }
	| { type: "session_opened"; wakeName: string }
	| { type: "session_closed" }
	| { type: "voice_changed"; voice: string }
	| { type: "voice_change_rejected"; requested?: string; reason: "unsupported" | "ambiguous" | "settings_write_failed" }
	| { type: "turn_queued"; position: number };

export interface RunResult {
	stopReason: string;
	errorMessage?: string;
	failureKind?: "model_credential_unavailable";
}

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface MessageReactionSummary {
	emoji: string;
	count: number;
	/** Resolved display names or stable Slack user IDs when Slack supplies them. */
	reactors?: string[];
}

export interface SendFinalResponseOptions {
	/** Deliver even when the channel is configured as messages-only. */
	force?: boolean;
}

export interface RespondOptions {
	/** The agent explicitly judged this safe tool label useful to surface. */
	show?: boolean;
}

export interface ToolProgressUpdate {
	id: string;
	label: string;
	status: "in_progress" | "complete" | "error";
	/** Whether the tool explicitly opted into the selective important stream. */
	show?: boolean;
}

export interface WorkingOutputContextOptions {
	toolStreaming: ToolStreamingMode;
	presentation: WorkingStreamPresentation;
	windowMinutes: number;
}

export interface ThreadTranscriptMessage {
	date?: string;
	ts: string;
	threadTs: string;
	channelId: string;
	channelName?: string;
	sender: string;
	text: string;
	isRoot: boolean;
	isBot?: boolean;
	directlyAddressed?: boolean;
	sourceEventType?: string;
	reactions?: MessageReactionSummary[];
}

export interface SlackThreadTargetInfo {
	channelId: string;
	channelName: string;
	threadTs: string;
	sendTarget: string;
	rootPreview: string;
	lastPreview: string;
	participants: string[];
	messageCount: number;
	lastSeen: string;
	source?: "slack-api" | "log";
}

export interface AdapterReadiness {
	ready: boolean;
	reason: string;
	checks: Record<string, boolean>;
}

export type SlashCommandResult = boolean | {
	handled: boolean;
	/** Resolves when an interactive command has finished sending follow-up output. */
	pending?: Promise<void>;
};

export function slashCommandHandled(result: SlashCommandResult): boolean {
	return typeof result === "boolean" ? result : result.handled;
}

export function slashCommandPending(result: SlashCommandResult): Promise<void> | undefined {
	return typeof result === "boolean" ? undefined : result.pending;
}

/**
 * The context object passed to the agent for each run.
 * Platform-agnostic — adapters create this from their platform primitives.
 */
export interface MomContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
			ts: string;
			freshContext?: boolean;
			sessionId?: string;
			eventType?: MomEvent["type"];
			sourceEventType?: string;
			contextProjection?: MomEvent["contextProjection"];
			deliveryId?: string;
			directlyAddressed?: boolean;
			threadTs?: string;
			replyTarget?: string;
			replyTargetDescription?: string;
			attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean, options?: RespondOptions) => Promise<void>;
	sendFinalResponse: (text: string, options?: SendFinalResponseOptions) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	/** How this context groups edited progress around deliberate message sends. */
	workingStreamPresentation?: WorkingStreamPresentation;
	/** Exact visible locus whose send_message deliveries split this working stream. Null disables rollover. */
	workingReplyTarget?: string | null;
	/** Finalize the current working message and start a fresh one (used by steering) */
	restartWorking: (headerLine?: string) => Promise<void>;
	/** Emit sanitized tool lifecycle to a platform-native progress surface. */
	updateToolProgress?: (update: ToolProgressUpdate) => Promise<void>;
	/** Emit a structured content block via SSE (web adapter only, others no-op) */
	emitContentBlock?: (block: { type: string; [key: string]: unknown }) => void;
}

/**
 * Handler interface that adapters call into when messages arrive.
 */
export interface MomHandler {
	/**
	 * Check if channel is currently running (SYNC)
	 */
	isRunning(channelId: string): boolean;

	/**
	 * Handle an event that triggers mom (ASYNC)
	 * Called only when isRunning() returned false for user messages.
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: MomEvent, adapter: PlatformAdapter, isEvent?: boolean): Promise<RunResult | void>;

	/**
	 * Handle a slash command before busy/steer routing.
	 * Returns true when the message was consumed as a command.
	 */
	handleSlashCommand(event: MomEvent, adapter: PlatformAdapter): Promise<SlashCommandResult>;

	/**
	 * Atomically admit one explicitly relationship-bound input. Exact active
	 * bindings steer strictly; true idle may start a turn; all other states reject.
	 */
	handleRelationshipBoundEvent(
		event: MomEvent,
		adapter: PlatformAdapter,
		request: RelationshipAdmissionRequest,
	): RelationshipAdmissionResult;

	/**
	 * Handle a message that arrives while the runtime is busy.
	 * Troublemaker soft-steers it at Pi's next safe model boundary, or queues a
	 * fresh canonical turn when the active model cannot currently accept it.
	 * This path never aborts the active run or tool.
	 */
	handleSteer(event: MomEvent, adapter: PlatformAdapter): Promise<void> | void;

	/**
	 * Accept a committed utterance from an explicit voice session. The resident
	 * voice contract performs wake/control gating and queues canonical turns at
	 * safe completion boundaries instead of steering the active model turn.
	 */
	handleVoiceEvent?(event: MomEvent, adapter: PlatformAdapter): void;

	/** Reset one transport voice session and discard only its queued turns. */
	closeVoiceSession?(sessionId: string, adapter: PlatformAdapter): void;

	/**
	 * Handle stop command (ASYNC)
	 * Called when user says "stop" while mom is running
	 */
	handleStop(channelId: string, adapter: PlatformAdapter, event?: MomEvent): Promise<void>;

	/**
	 * Check if a channel has pending input (e.g. /login waiting for pasted URL).
	 * If so, resolve it with the given text and return true.
	 * Callers should bypass the queue and return immediately.
	 */
	resolvePendingInput(channelId: string, text: string): boolean;
}

/**
 * Platform adapter interface. Each platform (Slack, Telegram, etc.)
 * implements this to connect mom to that platform.
 */
export interface PlatformAdapter {
	/** Adapter name (e.g., "slack", "telegram") */
	readonly name: string;

	/** Maximum message length for this platform */
	readonly maxMessageLength: number;

	/** Platform-specific formatting instructions for the system prompt */
	readonly formatInstructions: string;

	/** Start the adapter (connect to platform, but NOT the HTTP server — gateway handles that) */
	start(): Promise<void>;

	/** Stop the adapter */
	stop(): Promise<void>;

	/** Provider-specific live readiness; distinct from gateway liveness. */
	getReadiness?(): AdapterReadiness;

	/** Handle an inbound HTTP request (webhook adapters only — called by Gateway) */
	dispatch?(req: IncomingMessage, res: ServerResponse): void;

	// -- Message operations --

	postMessage(channel: string, text: string, attachments?: Array<{ filePath: string; filename: string }>, subject?: string): Promise<string>;
	/** Post harness-authored response UI using the same placement as a normal turn. */
	postResponseMessage?(event: MomEvent, text: string): Promise<string>;
	updateMessage(channel: string, ts: string, text: string): Promise<void>;
	deleteMessage(channel: string, ts: string): Promise<void>;
	postInThread(channel: string, threadTs: string, text: string): Promise<string>;
	/** Add an emoji reaction to one exact native message without posting text. */
	addReaction?(channel: string, messageTs: string, emoji: string): Promise<void>;
	readThread?(channel: string, threadTs: string, limit?: number): Promise<ThreadTranscriptMessage[]>;
	listThreads?(limit?: number): Promise<SlackThreadTargetInfo[]>;
	uploadFile(channel: string, filePath: string, title?: string): Promise<void>;

	// -- Logging --

	/** Log an entry to the unified workspace log.jsonl */
	logToFile(entry: object): void;
	logBotResponse(channel: string, text: string, ts: string, metadata?: { threadTs?: string }): void;

	// -- Metadata --

	getUser(userId: string): { id: string; userName: string; displayName: string } | undefined;
	getChannel(channelId: string): { id: string; name: string } | undefined;
	getAllUsers(): Array<{ id: string; userName: string; displayName: string }>;
	getAllChannels(): Array<{ id: string; name: string }>;

	// -- Context creation --

	createContext(event: MomEvent, store: ChannelStore, isEvent?: boolean): MomContext;
	/** Create a progress-only context at a durable destination, when supported. */
	createWorkingOutputContext?(
		target: WorkingOutputTarget,
		store: ChannelStore,
		options: WorkingOutputContextOptions,
	): MomContext;

	// -- Explicit voice session boundary hooks --

	/** Immediately stop currently buffered/playing assistant audio for this session. */
	interruptOutputAudio?(event: MomEvent): void;
	/** Apply local voice-session state without creating a canonical agent turn. */
	handleVoiceSessionNotice?(event: MomEvent, notice: VoiceSessionNotice): void;
	/** Apply a validated supported Realtime voice to a live transport when possible. */
	applyRealtimeVoice?(event: MomEvent, voice: string): void;

	// -- Event queue --

	enqueueEvent(event: MomEvent): boolean;
}
