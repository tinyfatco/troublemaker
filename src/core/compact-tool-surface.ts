import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Tool, type ToolCall } from "@earendil-works/pi-ai";

const CALL_TOOL: Tool = {
	name: "call_tool",
	description: "Call a tool by name with arguments matching its schema. bash accepts command and label. Discover other tools with search_tools first.",
	parameters: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["name", "arguments"] },
};

function wrapCall(call: ToolCall): ToolCall {
	return call.name === "search_tools" ? call : { ...call, name: "call_tool", arguments: { name: call.name, arguments: call.arguments } };
}

function unwrapCall(call: ToolCall): ToolCall {
	if (call.name !== "call_tool") return call;
	const args = call.arguments;
	if (typeof args.name !== "string" || args.name === "call_tool" || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) return call;
	return { ...call, name: args.name, arguments: args.arguments as Record<string, unknown> };
}

export function restoreCompactToolCalls(message: AssistantMessage): AssistantMessage {
	return { ...message, content: message.content.map(block => block.type === "toolCall" ? unwrapCall(block) : block) };
}

/** Only the provider view changes. Pi still executes real tools with its normal validation and hooks. */
export function compactToolContext(context: Context): Context {
	const search = context.tools?.find(tool => tool.name === "search_tools");
	if (!search) throw new Error("Compact tool surface requires search_tools");
	return {
		...context,
		tools: [search, CALL_TOOL],
		messages: context.messages.map(message => {
			if (message.role === "assistant") return { ...message, content: message.content.map(block => block.type === "toolCall" ? wrapCall(block) : block) };
			if (message.role === "toolResult" && message.toolName !== "search_tools") return { ...message, toolName: "call_tool" };
			return message;
		}),
	};
}

export function restoreCompactToolStream(source: AssistantMessageEventStream, fallback: AssistantMessage): AssistantMessageEventStream {
	const target = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") target.push({ ...event, message: restoreCompactToolCalls(event.message) });
				else if (event.type === "error") target.push({ ...event, error: restoreCompactToolCalls(event.error) });
				else if (event.type === "toolcall_end") target.push({ ...event, partial: restoreCompactToolCalls(event.partial), toolCall: unwrapCall(event.toolCall) });
				else target.push({ ...event, partial: restoreCompactToolCalls(event.partial) });
			}
			target.end(restoreCompactToolCalls(await source.result()));
		} catch (error) {
			target.push({ type: "error", reason: "error", error: { ...fallback, stopReason: "error", errorMessage: String(error) } });
		}
	})();
	return target;
}
