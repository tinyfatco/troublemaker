import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { RuntimeEventSink } from "../../core/runtime-contract.js";
import { normalizeSimpleStreamOptionsForModel } from "../../model-thinking.js";
import { LiveAssistantSnapshot } from "../../streaming/live-turn-snapshot.js";

export interface EdgeAgentSessionOptions {
	systemPrompt: string;
	model: Model<Api>;
	apiKey: string;
	tools: AgentTool<any>[];
	initialMessages?: AgentMessage[];
	thinkingLevel?: ModelThinkingLevel;
	sessionId?: string;
	terminalToolNames?: string[];
	emit: RuntimeEventSink;
	fetch?: typeof fetch;
}

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((message): message is Message => {
		if (!message || typeof message !== "object") return false;
		const role = (message as { role?: unknown }).role;
		return role === "user" || role === "assistant" || role === "toolResult";
	});
}

function toolResultText(result: unknown): string {
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return typeof result === "string" ? result : JSON.stringify(result);
	const text = content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const value = (part as { text?: unknown }).text;
			return typeof value === "string" ? value : "";
		})
		.filter(Boolean)
		.join("\n");
	return text || JSON.stringify(result);
}

export function createEdgeAgentSession(options: EdgeAgentSessionOptions): Agent {
	const liveSnapshot = new LiveAssistantSnapshot();
	const terminalTools = new Set(options.terminalToolNames || []);
	const emitSnapshot = async (isStreaming = true) => {
		const entry = liveSnapshot.current(isStreaming);
		if (entry) await options.emit({ type: "assistant_snapshot", entry, mode: "edge" });
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: options.systemPrompt,
			model: options.model,
			thinkingLevel: options.thinkingLevel ?? "off",
			tools: options.tools,
			messages: options.initialMessages ?? [],
		},
		convertToLlm,
		sessionId: options.sessionId,
		afterToolCall: async ({ toolCall, isError }) => {
			if (!isError && terminalTools.has(toolCall.name)) return { terminate: true };
			return undefined;
		},
		streamFn: async (model, context, streamOptions) =>
			streamSimple(
				model,
				context,
				normalizeSimpleStreamOptionsForModel(model, {
					...streamOptions,
					apiKey: options.apiKey,
				}),
			),
	});

	agent.subscribe(async (event: AgentEvent) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			liveSnapshot.beginAssistantMessage(event.message);
			await emitSnapshot(true);
			return;
		}

		if (event.type === "message_update") {
			liveSnapshot.updateAssistantMessage(event.message);
			await emitSnapshot(true);
			return;
		}

		if (event.type === "tool_execution_start") {
			const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
			liveSnapshot.upsertToolCall(
				event.toolCallId,
				event.toolName,
				args,
				toolCallLabel(args) || event.toolName,
			);
			await emitSnapshot(true);
			return;
		}

		if (event.type === "tool_execution_end") {
			liveSnapshot.upsertToolResult(event.toolCallId, toolResultText(event.result), event.isError);
			await emitSnapshot(true);
			return;
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			liveSnapshot.endAssistantMessage(event.message);
			await emitSnapshot(false);
		}
	});

	return agent;
}

function toolCallLabel(args: Record<string, unknown>): string | undefined {
	const label = args.label;
	return typeof label === "string" && label.trim() ? label.trim() : undefined;
}
