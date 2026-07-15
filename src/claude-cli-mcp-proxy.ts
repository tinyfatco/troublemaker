import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const CLAUDE_MCP_URL_ENV = "TROUBLEMAKER_CLAUDE_MCP_URL";
export const CLAUDE_MCP_TOKEN_ENV = "TROUBLEMAKER_CLAUDE_MCP_TOKEN";

export interface ClaudeCliMcpProxyEndpoint {
	url: URL;
	headers: { Authorization: string };
}

export function readClaudeCliMcpProxyEndpoint(
	env: NodeJS.ProcessEnv,
): ClaudeCliMcpProxyEndpoint {
	const rawUrl = env[CLAUDE_MCP_URL_ENV];
	const token = env[CLAUDE_MCP_TOKEN_ENV];
	if (!rawUrl || !token) throw new Error("Missing Troublemaker MCP proxy configuration");
	if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Troublemaker MCP proxy credential");

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("Invalid Troublemaker MCP proxy endpoint");
	}
	if (
		url.protocol !== "http:"
		|| url.hostname !== "127.0.0.1"
		|| !url.port
		|| !/^\/mcp\/[a-f0-9]{48}$/.test(url.pathname)
		|| url.username
		|| url.password
		|| url.search
		|| url.hash
	) {
		throw new Error("Invalid Troublemaker MCP proxy endpoint");
	}

	return {
		url,
		headers: { Authorization: `Bearer ${token}` },
	};
}

export async function runClaudeCliMcpProxy(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const endpoint = readClaudeCliMcpProxyEndpoint(env);
	const upstreamTransport = new StreamableHTTPClientTransport(endpoint.url, {
		requestInit: { headers: endpoint.headers },
	});
	const upstream = new Client({ name: "troublemaker-claude-cli-proxy", version: "1.0.0" });
	await upstream.connect(upstreamTransport);

	const downstream = new McpProtocolServer(
		{ name: "troublemaker", version: "1.0.0" },
		{
			capabilities: { tools: {} },
			instructions:
				"Use these Troublemaker runtime tools for all computer actions and user-visible delivery. "
				+ "Use send_message for visible replies and yield_no_action for silent ambient completion.",
		},
	);
	downstream.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
	downstream.setRequestHandler(CallToolRequestSchema, (request) => upstream.callTool(request.params));

	const downstreamTransport = new StdioServerTransport();
	let resolveClosed: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		await downstream.close().catch(() => {});
		await upstream.close().catch(() => {});
		resolveClosed?.();
	};
	const onSignal = () => void close();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	try {
		await downstream.connect(downstreamTransport);
		const onProtocolClose = downstreamTransport.onclose;
		downstreamTransport.onclose = () => {
			onProtocolClose?.();
			resolveClosed?.();
		};
		await closed;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await close();
	}
}

const isMain = !!process.argv[1]
	&& pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
	runClaudeCliMcpProxy().catch(() => {
		console.error("[claude-cli:mcp-proxy] Failed to start or relay MCP");
		process.exitCode = 1;
	});
}
