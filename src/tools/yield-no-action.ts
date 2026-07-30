/**
 * yield_no_action — end the current run with no output.
 *
 * The agent calls this when it has evaluated the situation and decided
 * there is nothing to say or do. The run terminates cleanly, no message
 * is posted to the channel, and the working message (if any) is deleted.
 *
 * This is the decision-boundary loop control for ambient, heartbeat, and
 * agent-authored turns. It never suppresses input: the agent evaluates the
 * message first, then yields only when no substantive response is needed.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import * as log from "../log.js";
import { YIELD_NO_ACTION_TOOL_DESCRIPTION } from "../yield-contract.js";

/** Shared flag — set by the tool, read by agent.ts after the run. */
let yielded = false;

export function wasYielded(): boolean {
	return yielded;
}

export function resetYield(): void {
	yielded = false;
}

/** Yield is an internal control action and must never surface in a channel. */
export function isYieldNoActionToolName(toolName: string): boolean {
	return toolName.split(".").pop() === "yield_no_action";
}

export function createYieldNoActionTool(): AgentTool<any> {
	const schema = Type.Object({
		reason: Type.String({
			description:
				"Brief internal note about why you're yielding (e.g., 'nothing to add', 'conversation is wrapping up', 'not my area'). " +
				"This is logged but never shown to users.",
		}),
	});

	return {
		name: "yield_no_action",
		label: "yield_no_action",
		description: YIELD_NO_ACTION_TOOL_DESCRIPTION,
		parameters: schema,
		execute: async (
			_toolCallId: string,
			params: unknown,
		) => {
			const { reason } = params as { reason: string };
			log.logInfo(`[yield_no_action] ${reason}`);
			yielded = true;
			return {
				content: [{ type: "text" as const, text: "Yielding. Do not produce any further output — the run is ending silently." }],
				details: undefined,
				terminate: true,
			};
		},
	};
}
