import { getCurrentSystemPrompt, getCurrentTools, type Context, type TranscriptContext } from "@earendil-works/pi-ai";

/**
 * Pi 1.x passes stream functions a TranscriptContext whose prompt and tool
 * declarations live in `role: "system"` messages. Troublemaker's stream
 * pipeline (CLI bridges, input budget, compact tool surface) works on the
 * folded `{ systemPrompt, tools, messages }` shape, so replay the transcript
 * once at the stream boundary. `streamSimple` from `pi-ai/compat` normalizes
 * it back before the provider sees it.
 */
export function toLegacyContext(context: TranscriptContext): Context {
	const tools = getCurrentTools(context.messages);
	return {
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: tools.length > 0 ? tools : undefined,
		messages: context.messages.filter((message) => message.role !== "system"),
	};
}
