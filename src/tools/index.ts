import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HostServices } from "../core/host.js";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createSpeakTool } from "./speak.js";
import { createWriteTool } from "./write.js";
import { enforceRequiredToolLabels } from "./tool-label.js";

export { setUploadFunction } from "./attach.js";
export { createSelfConfigureTool } from "./self-configure.js";
export { createSendMessageTool } from "./send-message.js";
export { createSpeakTool } from "./speak.js";
export { createSearchToolsTool } from "./search-tools.js";

export { createReadThreadTool } from "./read-thread.js";
export function createMomTools(executor: Executor, workspaceDir = process.cwd()): AgentTool<any>[] {
	return enforceRequiredToolLabels([
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		createSpeakTool(workspaceDir),
		attachTool,
	]);
}

export function createHostTools(host: Pick<HostServices, "executor">): AgentTool<any>[] {
	if (!host.executor) {
		return [attachTool];
	}
	return createMomTools(host.executor);
}
