import { existsSync, statSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const statusPath = "/tmp/troublemaker-peekaboo-app-smoke.json";
const imagePath = "/tmp/troublemaker-peekaboo-app-smoke.png";
const command = process.env.PEEKABOO_MCP_COMMAND || "/opt/homebrew/bin/peekaboo";
const args = (process.env.PEEKABOO_MCP_ARGS || "mcp --no-remote").trim().split(/\s+/).filter(Boolean);

function writeStatus(status) {
	writeFileSync(statusPath, `${JSON.stringify({
		...status,
		command,
		args,
		imagePath,
		timestamp: new Date().toISOString(),
	}, null, 2)}\n`);
}

function contentText(result) {
	return Array.isArray(result.content)
		? result.content.map((part) => part?.text).filter(Boolean).join("\n")
		: "";
}

const transport = new StdioClientTransport({
	command,
	args,
	stderr: "pipe",
	env: {
		...process.env,
		PEEKABOO_NO_REMOTE: process.env.PEEKABOO_NO_REMOTE || "1",
	},
});

const client = new Client(
	{ name: "troublemaker-app-smoke", version: "1.0.0" },
	{ capabilities: {} },
);

try {
	await client.connect(transport);
	const tools = await client.listTools();
	if (!tools.tools.some((tool) => tool.name === "image")) {
		throw new Error("Peekaboo MCP did not expose the image tool");
	}
	if (!tools.tools.some((tool) => tool.name === "see")) {
		throw new Error("Peekaboo MCP did not expose the see tool");
	}
	if (!tools.tools.some((tool) => tool.name === "permissions")) {
		throw new Error("Peekaboo MCP did not expose the permissions tool");
	}

	const permissions = await client.callTool({ name: "permissions", arguments: {} });
	if (permissions.isError === true) {
		const message = contentText(permissions) || "permissions tool returned an error";
		throw new Error(message || "permissions tool returned an error");
	}
	const permissionsText = contentText(permissions);

	const result = await client.callTool({
		name: "image",
		arguments: {
			app_target: "screen:0",
			path: imagePath,
			format: "png",
		},
	});

	if (result.isError === true) {
		const message = Array.isArray(result.content)
			? result.content.map((part) => part?.text).filter(Boolean).join("\n")
			: "image tool returned an error";
		throw new Error(message || "image tool returned an error");
	}

	if (!existsSync(imagePath) || statSync(imagePath).size === 0) {
		throw new Error(`expected screenshot at ${imagePath}`);
	}

	let accessibilitySmoke = { success: false, warning: "not run" };
	if (tools.tools.some((tool) => tool.name === "inspect_ui")) {
		try {
			const inspect = await client.callTool({
				name: "inspect_ui",
				arguments: {
					app_target: "System Settings",
					max_depth: 2,
					max_elements: 80,
				},
			});
			accessibilitySmoke = inspect.isError === true
				? { success: false, warning: contentText(inspect) || "inspect_ui returned an error" }
				: { success: true };
		} catch (error) {
			accessibilitySmoke = {
				success: false,
				warning: error instanceof Error ? error.message : String(error),
			};
		}
	}

	writeStatus({
		success: true,
		toolCount: tools.tools.length,
		permissions: permissionsText,
		accessibilitySmoke,
	});
} catch (error) {
	writeStatus({
		success: false,
		error: error instanceof Error ? error.message : String(error),
	});
	process.exitCode = 1;
} finally {
	await client.close().catch(() => {});
}
