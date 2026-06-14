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
