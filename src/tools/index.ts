import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { HostServices } from "../core/host.js";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";
export { createSendMessageTool } from "./send-message.js";

export function createMomTools(executor: Executor): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
	];
}

export function createHostTools(host: Pick<HostServices, "executor">): AgentTool<any>[] {
	if (!host.executor) {
		return [attachTool];
	}
	return createMomTools(host.executor);
}
