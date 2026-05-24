import type { BashToolInput, BashToolResult } from "../../core/tool-definitions.js";

export interface EdgeHostBridge {
	executeBash(input: BashToolInput, signal?: AbortSignal): Promise<BashToolResult>;
}
