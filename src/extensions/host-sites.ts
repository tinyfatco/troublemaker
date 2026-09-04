import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSiteDeployToolDefinitions } from "../tools/site-deploy.js";

export default function hostSitesExtension(pi: ExtensionAPI): void {
	for (const tool of createSiteDeployToolDefinitions()) {
		pi.registerTool(tool);
	}
}
