export interface WebTurnProjectContext {
	siteId?: string;
	slug: string;
	displayName?: string;
	templateId?: string;
	templateFamily?: string;
	templateVersion?: string;
	templateName?: string;
	stack?: string;
	deployMode?: string;
	editMode?: string;
	contentSurface?: string;
	adminUrl?: string;
	mcpUrl?: string;
	previewUrl?: string;
	productionUrl?: string;
	state?: string;
	workspacePath?: string;
	latestDeploymentUrl?: string;
	latestDeploymentState?: string;
}

export interface WebTurnInput {
	message: string;
	channelId: string;
	source: string;
	project?: WebTurnProjectContext;
}

export interface EmailTurnInput extends WebTurnInput {
	source: string;
	email: {
		from: string;
		to: string;
		subject?: string;
		messageId?: string;
		inReplyTo?: string;
		references?: string;
	};
}

export type EdgeTextTurnInput = WebTurnInput | EmailTurnInput;

export interface WebTurnSettings {
	turnSurface?: string;
	hostedTurnSurface?: string;
	modelProvider?: string;
	modelId?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	systemPrompt?: string;
}

export type RuntimeMode = "edge" | "host";

export interface RuntimeStatusEvent {
	type: "status";
	status: "accepted" | "waking" | "connecting" | "container" | "steering" | "streaming" | "compacting";
	message?: string;
	mode?: RuntimeMode;
}

export interface RuntimeErrorEvent {
	type: "error";
	message: string;
	mode?: RuntimeMode;
}

export interface RuntimeTextContent {
	type: "text";
	text: string;
	contentIndex?: number;
}

export interface RuntimeThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	contentIndex?: number;
}

export interface RuntimeToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	label?: string;
	arguments: Record<string, unknown>;
	contentIndex?: number;
	startedAt?: string;
}

export type RuntimeToolOutputStream = "stdout" | "stderr" | "system";

export interface RuntimeToolOutputContent {
	type: "toolOutput";
	toolCallId: string;
	stream: RuntimeToolOutputStream;
	text: string;
	pid?: number;
	sequence?: number;
}

export interface RuntimeToolResultContent {
	type: "toolResult";
	toolCallId: string;
	result: string;
	isError?: boolean;
}

export type RuntimeAssistantSnapshotContent =
	| RuntimeTextContent
	| RuntimeThinkingContent
	| RuntimeToolCallContent
	| RuntimeToolOutputContent
	| RuntimeToolResultContent;

export interface RuntimeAssistantSnapshotEntry {
	id: string;
	type: "message";
	timestamp: string;
	role: "assistant";
	content: RuntimeAssistantSnapshotContent[];
	model?: string;
	stopReason?: string;
	isStreaming?: boolean;
}

export interface RuntimeAssistantSnapshotEvent {
	type: "assistant_snapshot";
	entry: RuntimeAssistantSnapshotEntry;
	mode?: RuntimeMode;
}

export type RuntimeAssistantTextOutcome = "completed" | "cancelled" | "failed";

export interface RuntimeAssistantTextPresentationSegment {
	id: string;
	index: number;
	revision: number;
	text: string;
	isFinal: boolean;
	startedAt: string;
	durableMessageIds?: string[];
}

/**
 * Exact public assistant prose for one canonical run. Streaming records are
 * cumulative patches; the terminal record reconciles them to durable message
 * identity. It never carries thinking or tool payloads.
 */
export interface RuntimeAssistantTextEvent {
	type: "assistant_text";
	completionId: string;
	revision: number;
	text: string;
	isFinal: boolean;
	outcome?: RuntimeAssistantTextOutcome;
	durableMessageIds?: string[];
	speechEligible: boolean;
	/**
	 * Additive visual projection. A presentation segment is bounded by any
	 * visible user, tool, or runtime-status event, while completionId remains
	 * the parent run identity used for delivery and speech reconciliation.
	 */
	presentationMode?: "ordered_segments";
	presentationSegment?: RuntimeAssistantTextPresentationSegment;
	mode?: RuntimeMode;
}

export interface RuntimeUserInputEntry {
	channel: string;
	userName: string;
	text: string;
}

/** Sanitized transcript input emitted before its run can paint assistant output. */
export interface RuntimeUserInputEvent {
	type: "user_input";
	entries: RuntimeUserInputEntry[];
	mode?: RuntimeMode;
}

export interface RuntimeSteeringInputEvent {
	type: "steering_input";
	id: string;
	state: "accepted" | "consumed" | "dismissed";
	deliveryMode: "steered";
	acceptedAt: string;
	entries: RuntimeUserInputEntry[];
	mode?: RuntimeMode;
}

export interface RuntimeTextDeltaEvent {
	type: "text_delta";
	contentIndex?: number;
	delta: string;
	text?: string;
}

export interface RuntimeTextPatchEvent {
	type: "text_patch";
	contentIndex?: number;
	text: string;
}

export interface RuntimeThinkingDeltaEvent {
	type: "thinking_delta";
	contentIndex?: number;
	delta: string;
	thinking?: string;
}

export interface RuntimeThinkingPatchEvent {
	type: "thinking_patch";
	contentIndex?: number;
	thinking: string;
}

export interface RuntimeToolCallEvent {
	type: "toolCall" | "toolcall_start" | "toolcall_delta" | "toolcall_end";
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	contentIndex?: number;
	delta?: string;
	toolCall?: {
		type: "toolCall";
		id: string;
		name: string;
		label?: string;
		arguments: Record<string, unknown>;
		contentIndex?: number;
	};
	toolCalls?: Array<{
		type: "toolCall";
		id: string;
		name: string;
		label?: string;
		arguments: Record<string, unknown>;
		contentIndex?: number;
	}>;
}

export interface RuntimeToolResultEvent {
	type: "toolResult";
	toolCallId: string;
	result: string;
	isError?: boolean;
}

export interface RuntimeToolResultDeltaEvent {
	type: "toolResultDelta";
	toolCallId: string;
	stream: RuntimeToolOutputStream;
	text: string;
	pid?: number;
	sequence?: number;
	mode?: RuntimeMode;
}

export interface RuntimeRunCompleteEvent {
	type: "run_complete";
	channelId?: string;
	mode?: RuntimeMode;
}

export type RuntimeStreamEvent =
	| RuntimeStatusEvent
	| RuntimeErrorEvent
	| RuntimeAssistantSnapshotEvent
	| RuntimeAssistantTextEvent
	| RuntimeUserInputEvent
	| RuntimeSteeringInputEvent
	| RuntimeTextDeltaEvent
	| RuntimeTextPatchEvent
	| RuntimeThinkingDeltaEvent
	| RuntimeThinkingPatchEvent
	| RuntimeToolCallEvent
	| RuntimeToolResultDeltaEvent
	| RuntimeToolResultEvent
	| RuntimeRunCompleteEvent;

export type RuntimeEventSink = (event: RuntimeStreamEvent) => void | Promise<void>;

export interface RuntimeLiveRunMetadata {
	runId: string;
	channelId: string;
	channelLabel?: string;
	source?: string;
}

interface RuntimeLiveEventBase {
	/** Monotonic within one resident runtime process. */
	sequence: number;
	/** Changes whenever the resident runtime process restarts. */
	streamId: string;
	id: string;
	timestamp: string;
}

export interface RuntimeLiveAwarenessEvent extends RuntimeLiveEventBase {
	kind: "awareness";
	line: string;
	awarenessId?: string;
}

export interface RuntimeLiveRunEvent extends RuntimeLiveEventBase, RuntimeLiveRunMetadata {
	kind: "runtime";
	event: RuntimeStreamEvent;
}

export interface RuntimeLiveResetEvent extends RuntimeLiveEventBase {
	kind: "reset";
	reason: "context_rotated" | "replay_gap";
}

/**
 * The terminal's one live transport. Durable awareness entries and ephemeral
 * in-flight runtime snapshots share this ordered envelope.
 */
export type RuntimeLiveEvent = RuntimeLiveAwarenessEvent | RuntimeLiveRunEvent | RuntimeLiveResetEvent;
