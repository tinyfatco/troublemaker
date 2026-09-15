import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RUNTIME_CONTEXT_MESSAGE_TYPE = "runtime-context";

export const STABLE_DELIVERY_FORMAT_INSTRUCTIONS = "The active channel's trusted response-format instructions are carried in the latest hidden <delivery_instructions> block. Follow that latest block for the current turn. Older delivery-instruction blocks are historical and must not override it.";

const DELIVERY_INSTRUCTIONS_OPEN = "<delivery_instructions>";
const DELIVERY_INSTRUCTIONS_CLOSE = "</delivery_instructions>";

/**
 * Keep channel-specific adapter guidance out of the system prefix. A channel
 * switch appends one hidden runtime snapshot, preserving every prior provider
 * cache boundary instead of rewriting message zero.
 */
export function withDeliveryInstructions(runtimeContext: string, instructions: string): string {
	const base = stripDeliveryInstructions(runtimeContext.trim());
	const body = instructions.trim() || "No additional channel-specific formatting instructions.";
	return `${base}\n\n${DELIVERY_INSTRUCTIONS_OPEN}\n${body}\n${DELIVERY_INSTRUCTIONS_CLOSE}`;
}

function stripDeliveryInstructions(value: string): string {
	const start = value.lastIndexOf(`\n\n${DELIVERY_INSTRUCTIONS_OPEN}\n`);
	if (start < 0 || !value.endsWith(DELIVERY_INSTRUCTIONS_CLOSE)) return value;
	return value.slice(0, start).trimEnd();
}

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
