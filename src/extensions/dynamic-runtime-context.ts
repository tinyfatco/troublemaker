import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Keep the latest dynamic workspace/session context in the system prompt rather
 * than appending another complete copy to every user message in the transcript.
 * Pi evaluates this hook after any pre-turn compaction, so the context cannot
 * become a stale reference when compaction happens immediately before a turn.
 */
export function createDynamicRuntimeContextExtension(
	getSystemPrompt: () => string,
	getRuntimeContext: () => string,
) {
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", async (event) => {
			const systemPrompt = getSystemPrompt().trim() || event.systemPrompt.trim();
			const runtimeContext = getRuntimeContext().trim();
			if (!runtimeContext) return { systemPrompt };
			return {
				systemPrompt: `${systemPrompt}\n\n${runtimeContext}`,
			};
		});
	};
}
