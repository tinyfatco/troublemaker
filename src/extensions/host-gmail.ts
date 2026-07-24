import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGmailToolDefinitions } from "../tools/gmail.js";

export default function hostGmailExtension(pi: ExtensionAPI): void {
	for (const tool of createGmailToolDefinitions()) {
		pi.registerTool(tool);
	}
}
