import type { BashToolInput, BashToolResult } from "../../core/tool-definitions.js";
import type { WebTurnProjectContext } from "../../core/runtime-contract.js";
import type { RuntimeToolOutputStream } from "../../core/runtime-contract.js";

export interface EdgeBashOutputEvent {
	stream: RuntimeToolOutputStream;
	text: string;
	pid?: number;
	sequence?: number;
}

export type EdgeBashOutputSink = (event: EdgeBashOutputEvent) => void | Promise<void>;

export interface EdgeHostBridge {
	executeBash(input: BashToolInput, signal?: AbortSignal, onOutput?: EdgeBashOutputSink): Promise<BashToolResult>;
}

export interface EdgeDeployPreviewInput {
	label?: string;
	html: string;
	deployMessage?: string;
}

export interface EdgeDeployPreviewResult {
	url: string;
	deploymentId?: string | null;
	project: WebTurnProjectContext;
}

export interface EdgeManagedProjectBridge {
	deployPreview(input: EdgeDeployPreviewInput, signal?: AbortSignal): Promise<EdgeDeployPreviewResult>;
}

export interface EdgeWorkspaceReadInput {
	path: string;
	maxBytes?: number;
}

export interface EdgeWorkspaceReadResult {
	path: string;
	content: string;
	truncated?: boolean;
}

export interface EdgeWorkspaceWriteInput {
	path: string;
	content: string;
}

export interface EdgeWorkspaceWriteResult {
	path: string;
	bytes: number;
}

export interface EdgeWorkspaceEditInput {
	path: string;
	oldText: string;
	newText: string;
	replaceAll?: boolean;
}

export interface EdgeWorkspaceEditResult {
	path: string;
	replacements: number;
	bytes: number;
}

export interface EdgeWorkspaceBridge {
	readFile(input: EdgeWorkspaceReadInput, signal?: AbortSignal): Promise<EdgeWorkspaceReadResult>;
	writeFile(input: EdgeWorkspaceWriteInput, signal?: AbortSignal): Promise<EdgeWorkspaceWriteResult>;
	editFile(input: EdgeWorkspaceEditInput, signal?: AbortSignal): Promise<EdgeWorkspaceEditResult>;
}
