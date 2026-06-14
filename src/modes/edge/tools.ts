import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
	bashToolSchema,
	DEFAULT_BASH_TIMEOUT_SECONDS,
	type BashToolInput,
} from "../../core/tool-definitions.js";
import type { RuntimeEventSink, WebTurnProjectContext } from "../../core/runtime-contract.js";
import type {
	EdgeDeployPreviewInput,
	EdgeManagedProjectBridge,
	EdgeHostBridge,
	EdgeWorkspaceBridge,
	EdgeWorkspaceEditInput,
	EdgeWorkspaceReadInput,
	EdgeWorkspaceWriteInput,
} from "./host-bridge.js";

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

export const readFileToolSchema = Type.Object({
	path: Type.String({
		description: "Relative workspace path to read. Use paths like BOOTSTRAP.md, MEMORY.md, projects/site/index.html, or notes/today.md.",
	}),
	maxBytes: Type.Optional(Type.Number({
		description: "Optional maximum plaintext bytes to return, capped by the edge runtime.",
	})),
});

export const writeFileToolSchema = Type.Object({
	path: Type.String({
		description: "Relative workspace path to write.",
	}),
	content: Type.String({
		description: "Complete file content to write. This replaces the existing file.",
	}),
});

export const editFileToolSchema = Type.Object({
	path: Type.String({
		description: "Relative workspace path to edit.",
	}),
	oldText: Type.String({
		description: "Exact text currently in the file.",
	}),
	newText: Type.String({
		description: "Replacement text.",
	}),
	replaceAll: Type.Optional(Type.Boolean({
		description: "Replace all occurrences instead of requiring exactly one occurrence.",
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

export function createEdgeReadFileTool(
	bridge: EdgeWorkspaceBridge,
): AgentTool<typeof readFileToolSchema> {
	return {
		name: "read",
		label: "read",
		description: [
			"Read a UTF-8 text file from the agent's encrypted TinyFat workspace.",
			"Paths are relative to the workspace root and cannot be absolute or contain .. segments.",
		].join(" "),
		parameters: readFileToolSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, input: EdgeWorkspaceReadInput, signal?: AbortSignal) => {
			const result = await bridge.readFile(input, signal);
			return {
				content: [{
					type: "text",
					text: result.truncated
						? `${result.content}\n\n[read truncated by edge runtime]`
						: result.content,
				}],
				details: result,
			};
		},
	};
}

export function createEdgeWriteFileTool(
	bridge: EdgeWorkspaceBridge,
): AgentTool<typeof writeFileToolSchema> {
	return {
		name: "write",
		label: "write",
		description: [
			"Write a UTF-8 text file to the agent's encrypted TinyFat workspace.",
			"Paths are relative to the workspace root and this replaces the file content.",
		].join(" "),
		parameters: writeFileToolSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, input: EdgeWorkspaceWriteInput, signal?: AbortSignal) => {
			const result = await bridge.writeFile(input, signal);
			return {
				content: [{
					type: "text",
					text: `Wrote ${result.bytes} bytes to ${result.path}`,
				}],
				details: result,
			};
		},
	};
}

export function createEdgeEditFileTool(
	bridge: EdgeWorkspaceBridge,
): AgentTool<typeof editFileToolSchema> {
	return {
		name: "edit",
		label: "edit",
		description: [
			"Edit a UTF-8 text file in the agent's encrypted TinyFat workspace by exact text replacement.",
			"Use replaceAll only when every occurrence should change.",
		].join(" "),
		parameters: editFileToolSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, input: EdgeWorkspaceEditInput, signal?: AbortSignal) => {
			const result = await bridge.editFile(input, signal);
			return {
				content: [{
					type: "text",
					text: `Edited ${result.path}: ${result.replacements} replacement${result.replacements === 1 ? "" : "s"}, ${result.bytes} bytes now`,
				}],
				details: result,
			};
		},
	};
}
