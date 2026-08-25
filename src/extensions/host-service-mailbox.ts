import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServiceMailboxToolDefinitions } from "../tools/service-mailbox.js";

export default function hostServiceMailboxExtension(pi: ExtensionAPI): void {
	for (const tool of createServiceMailboxToolDefinitions()) {
		pi.registerTool(tool);
	}
}
