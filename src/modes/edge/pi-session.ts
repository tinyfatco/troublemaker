import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { streamSimple, type Api, type Message, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { RuntimeEventSink } from "../../core/runtime-contract.js";
import { normalizeSimpleStreamOptionsForModel } from "../../model-thinking.js";

export interface EdgeAgentSessionOptions {
	systemPrompt: string;
	model: Model<Api>;
	apiKey: string;
	tools: AgentTool<any>[];
	initialMessages?: AgentMessage[];
	thinkingLevel?: ModelThinkingLevel;
	sessionId?: string;
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

function contentText(content: unknown): string | undefined {
	if (!content || typeof content !== "object") return undefined;
	const text = (content as { text?: unknown }).text;
	return typeof text === "string" ? text : undefined;
}

function contentThinking(content: unknown): string | undefined {
	if (!content || typeof content !== "object") return undefined;
	const thinking = (content as { thinking?: unknown }).thinking;
	return typeof thinking === "string" ? thinking : undefined;
}

function partialText(event: unknown): string | undefined {
	const partial = (event as { partial?: { content?: unknown[] } }).partial;
	if (!Array.isArray(partial?.content)) return undefined;
	return partial.content
		.map(contentText)
		.filter((text): text is string => typeof text === "string")
		.join("");
}

function partialThinking(event: unknown): string | undefined {
	const partial = (event as { partial?: { content?: unknown[] } }).partial;
	if (!Array.isArray(partial?.content)) return undefined;
	return partial.content
		.map(contentThinking)
		.filter((thinking): thinking is string => typeof thinking === "string")
		.join("");
}

function normalizeToolCalls(event: any) {
	const calls: Array<{
		type: "toolCall";
		id: string;
		name: string;
		arguments: Record<string, unknown>;
		contentIndex?: number;
	}> = [];
	const seen = new Set<string>();

	const add = (raw: any, fallbackIndex?: number) => {
		if (!raw || raw.type !== "toolCall") return;
		const contentIndex = typeof raw.contentIndex === "number" ? raw.contentIndex : fallbackIndex;
		const id = String(raw.id ?? event.id ?? "");
		const key = id ? `id:${id}` : `index:${contentIndex ?? calls.length}`;
		if (seen.has(key)) return;
		seen.add(key);
		calls.push({
			type: "toolCall",
			id,
			name: String(raw.name ?? event.name ?? "tool"),
			arguments: raw.arguments && typeof raw.arguments === "object" ? raw.arguments : {},
			contentIndex,
		});
	};

	if (Array.isArray(event.toolCalls)) {
		event.toolCalls.forEach((raw: unknown, index: number) => add(raw, index));
	}
	add(event.toolCall, typeof event.contentIndex === "number" ? event.contentIndex : undefined);
	if (Array.isArray(event.partial?.content)) {
		event.partial.content.forEach((raw: unknown, index: number) => add(raw, index));
	}
	return calls;
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
		if (event.type === "message_update") {
			const ame = event.assistantMessageEvent as any;
			if (ame.type === "text_delta") {
				await options.emit({
					type: "text_delta",
					contentIndex: ame.contentIndex,
					delta: typeof ame.delta === "string" ? ame.delta : "",
					text: partialText(ame),
				});
			} else if (ame.type === "text_start" || ame.type === "text_end") {
				const text = partialText(ame);
				if (text !== undefined) {
					await options.emit({ type: "text_patch", contentIndex: ame.contentIndex, text });
				}
			} else if (ame.type === "thinking_delta") {
				await options.emit({
					type: "thinking_delta",
					contentIndex: ame.contentIndex,
					delta: typeof ame.delta === "string" ? ame.delta : "",
					thinking: partialThinking(ame),
				});
			} else if (ame.type === "thinking_start" || ame.type === "thinking_end") {
				const thinking = partialThinking(ame);
				if (thinking !== undefined) {
					await options.emit({ type: "thinking_patch", contentIndex: ame.contentIndex, thinking });
				}
			} else if (ame.type === "toolcall_start" || ame.type === "toolcall_delta" || ame.type === "toolcall_end") {
				const toolCalls = normalizeToolCalls(ame);
				if (toolCalls.length > 0) {
					await options.emit({
						type: ame.type,
						contentIndex: ame.contentIndex,
						delta: ame.delta,
						toolCall: toolCalls[0],
						toolCalls,
					});
				}
			}
			return;
		}

		if (event.type === "tool_execution_start") {
			await options.emit({
				type: "toolCall",
				id: event.toolCallId,
				name: event.toolName,
				arguments: event.args && typeof event.args === "object" ? event.args : {},
			});
			return;
		}

		if (event.type === "tool_execution_end") {
			await options.emit({
				type: "toolResult",
				toolCallId: event.toolCallId,
				result: toolResultText(event.result),
				isError: event.isError,
			});
			return;
		}

		if (event.type === "message_end" && event.message.role === "assistant") {
			const text = event.message.content
				.map((part) => part.type === "text" ? part.text : "")
				.filter(Boolean)
				.join("\n");
			if (text.trim()) {
				await options.emit({ type: "text_patch", text });
			}
		}
	});

	return agent;
}
