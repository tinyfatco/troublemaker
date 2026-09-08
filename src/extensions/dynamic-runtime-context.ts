import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RUNTIME_CONTEXT_MESSAGE_TYPE = "runtime-context";

/**
 * Keep the system prefix stable. Changed workspace context is an append-only
 * hidden message, not a rewrite of the system prompt or earlier history.
 * Read the actual model history after pre-turn compaction/projection so a
 * removed snapshot is restored and a retained snapshot is not duplicated.
 */
export function createDynamicRuntimeContextExtension(
	getSystemPrompt: () => string,
	getRuntimeContext: () => string,
	getMessages: () => readonly AgentMessage[],
) {
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", async (event) => {
			const systemPrompt = getSystemPrompt().trim() || event.systemPrompt.trim();
			const runtimeContext = getRuntimeContext().trim();
			if (!runtimeContext) return { systemPrompt };
			const latest = [...getMessages()].reverse().find((message) =>
				message.role === "custom" && message.customType === RUNTIME_CONTEXT_MESSAGE_TYPE,
			);
			if (latest?.role === "custom" && latest.content === runtimeContext) return { systemPrompt };
			return {
				systemPrompt,
				message: {
					customType: RUNTIME_CONTEXT_MESSAGE_TYPE,
					content: runtimeContext,
					display: false,
				},
			};
		});
	};
}
