import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpConnectionToolDefinitions } from "../tools/mcp-connections.js";

export default function hostMcpConnectionsExtension(pi: ExtensionAPI): void {
	for (const tool of createMcpConnectionToolDefinitions()) {
		pi.registerTool(tool);
	}
}
