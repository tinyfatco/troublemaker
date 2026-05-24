export interface WebTurnInput {
	message: string;
	channelId: string;
	source: string;
}

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
	status: "accepted" | "waking" | "connecting" | "container" | "steering" | "streaming";
	message?: string;
	mode?: RuntimeMode;
}

export interface RuntimeErrorEvent {
	type: "error";
	message: string;
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
		arguments: Record<string, unknown>;
		contentIndex?: number;
	};
	toolCalls?: Array<{
		type: "toolCall";
		id: string;
		name: string;
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

export type RuntimeToolOutputStream = "stdout" | "stderr" | "system";

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
	| RuntimeTextDeltaEvent
	| RuntimeTextPatchEvent
	| RuntimeThinkingDeltaEvent
	| RuntimeThinkingPatchEvent
	| RuntimeToolCallEvent
	| RuntimeToolResultDeltaEvent
	| RuntimeToolResultEvent
	| RuntimeRunCompleteEvent;

export type RuntimeEventSink = (event: RuntimeStreamEvent) => void | Promise<void>;
