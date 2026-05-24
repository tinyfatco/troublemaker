import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	bashToolSchema,
	DEFAULT_BASH_TIMEOUT_SECONDS,
	type BashToolInput,
} from "../../core/tool-definitions.js";
import type { EdgeHostBridge } from "./host-bridge.js";

export function createEdgeBashTool(hostBridge: EdgeHostBridge): AgentTool<typeof bashToolSchema> {
	return {
		name: "bash",
		label: "bash",
		description: "Execute a bash command in the agent host container. In edge mode this wakes the host only when shell execution is required.",
		parameters: bashToolSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, input: BashToolInput, signal?: AbortSignal) => {
			const result = await hostBridge.executeBash({
				...input,
				timeout: input.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS,
			}, signal);

			let text = "";
			if (result.stdout) text += result.stdout;
			if (result.stderr) {
				if (text) text += "\n";
				text += result.stderr;
			}
			if (!text) text = "(no output)";
			if (result.code !== 0) {
				throw new Error(`${text}\n\nCommand exited with code ${result.code}`.trim());
			}
			return { content: [{ type: "text", text }], details: { code: result.code } };
		},
	};
}
