import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDomainToolDefinitions } from "../tools/domains.js";

export default function tinyfatDomainsExtension(pi: ExtensionAPI): void {
	for (const tool of createDomainToolDefinitions({
		authToken: process.env.FAT_TOOLS_TOKEN,
		brokerUrl: process.env.DOMAIN_BROKER_URL,
	})) {
		pi.registerTool(tool);
	}
}
