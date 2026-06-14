import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
	bashToolSchema,
	DEFAULT_BASH_TIMEOUT_SECONDS,
	type BashToolInput,
} from "../../core/tool-definitions.js";
import type { RuntimeEventSink, WebTurnProjectContext } from "../../core/runtime-contract.js";
import type { EdgeDeployPreviewInput, EdgeManagedProjectBridge, EdgeHostBridge } from "./host-bridge.js";

export const deployPreviewToolSchema = Type.Object({
	label: Type.Optional(Type.String({
		description: "Brief description of the preview deploy, shown to the user.",
	})),
	html: Type.String({
		description: "Complete static HTML document to publish as index.html. Include <!doctype html>, <html>, <head>, and <body>.",
	}),
	deployMessage: Type.Optional(Type.String({
		description: "Short deployment message for the preview history.",
	})),
});

export function createEdgeBashTool(
	hostBridge: EdgeHostBridge,
	emit?: RuntimeEventSink,
): AgentTool<typeof bashToolSchema> {
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
			}, signal, (event) => {
				return emit?.({
					type: "toolResultDelta",
					toolCallId: _toolCallId,
					stream: event.stream,
					text: event.text,
					pid: event.pid,
					sequence: event.sequence,
					mode: "host",
				});
			});

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

export function createEdgeDeployPreviewTool(
	project: WebTurnProjectContext,
	bridge: EdgeManagedProjectBridge,
): AgentTool<typeof deployPreviewToolSchema> {
	return {
		name: "deploy_preview",
		label: "deploy preview",
		description: [
			"Publish a complete static HTML page to the currently selected TinyFat website project's managed preview URL.",
			"This is an edge-native TinyFat deploy, not shell access and not a container.",
			`Current project: ${project.displayName || project.slug} (${project.slug}).`,
		].join(" "),
		parameters: deployPreviewToolSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, input: EdgeDeployPreviewInput, signal?: AbortSignal) => {
			const result = await bridge.deployPreview(input, signal);
			return {
				content: [{
					type: "text",
					text: `Preview deployed for ${result.project.displayName || result.project.slug}: ${result.url}`,
				}],
				details: result,
			};
		},
	};
}
