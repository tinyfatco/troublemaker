import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as log from "../log.js";
import { loadMcpConfigs, type ResolvedMcpServer } from "./config.js";
import { wrapMcpTool } from "./wrap-tool.js";

interface ConnectedServer {
	alias: string;
	client: Client;
	transport: Transport;
	tools: AgentTool<any>[];
}

function isLocalComputerUseServer(config: ResolvedMcpServer): boolean {
	return config.alias === "computer-use"
		&& config.transport === "stdio"
		&& config.scopes.includes("computer:use");
}

export function isComputerUseAppApproval(params: unknown): boolean {
	if (!params || typeof params !== "object" || Array.isArray(params)) return false;
	const request = params as Record<string, unknown>;
	if (request.mode !== undefined && request.mode !== "form") return false;
	if (typeof request.message !== "string" || !/^Allow ChatGPT to use .+\?$/.test(request.message)) return false;

	const schema = request.requestedSchema;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const schemaRecord = schema as Record<string, unknown>;
	if (schemaRecord.type !== "object") return false;
	const properties = schemaRecord.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
	if (Object.keys(properties as Record<string, unknown>).length !== 0) return false;

	const meta = request._meta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
	const persist = (meta as Record<string, unknown>).persist;
	return Array.isArray(persist) && persist.includes("always");
}

export class McpBridge {
	private servers: ConnectedServer[] = [];
	private workspaceDir: string;
	private connected = false;
	private connectPromise: Promise<void> | null = null;

	constructor(workspaceDir: string) {
		this.workspaceDir = workspaceDir;
	}

	/**
	 * Returns a promise that resolves when the ongoing connect() finishes
	 * (success or per-server failures — never rejects). If connect() has
	 * not been called yet, returns a resolved promise.
	 */
	ready(): Promise<void> {
		return this.connectPromise ?? Promise.resolve();
	}

	async connect(): Promise<void> {
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = this.doConnect();
		return this.connectPromise;
	}

	private async doConnect(): Promise<void> {
		if (this.connected) return;

		const configs = loadMcpConfigs(this.workspaceDir);
		if (configs.length === 0) {
			log.logInfo("[mcp-client] No MCP servers configured");
			this.connected = true;
			return;
		}

		log.logInfo(`[mcp-client] Connecting to ${configs.length} MCP server(s)`);

		const results = await Promise.allSettled(
			configs.map((config) => this.connectOne(config)),
		);

		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			const config = configs[i];
			if (result.status === "rejected") {
				const source = config.transport === "stdio"
					? `${config.command} ${config.args.join(" ")}`.trim()
					: config.url;
				log.logWarning(
					`[mcp-client] Failed to connect to "${config.alias}" (${source})`,
					String(result.reason),
				);
			}
		}

		this.connected = true;
		const toolCount = this.servers.reduce((sum, s) => sum + s.tools.length, 0);
		log.logInfo(`[mcp-client] Connected: ${this.servers.length} server(s), ${toolCount} tools`);
	}

	private async connectOne(config: ResolvedMcpServer): Promise<void> {
		const transport: Transport = config.transport === "stdio"
			? new StdioClientTransport({
				command: config.command,
				args: config.args,
				cwd: config.cwd,
				env: config.env,
				stderr: "pipe",
			})
			: new StreamableHTTPClientTransport(new URL(config.url), {
				requestInit: {
					headers: {
						Authorization: `Bearer ${config.token}`,
					},
				},
			});

		if (config.transport === "stdio" && transport instanceof StdioClientTransport) {
			transport.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf-8").trim();
				if (text) log.logInfo(`[mcp-client] ${config.alias} stderr: ${text.substring(0, 500)}`);
			});
		}

		const allowsComputerUseAppApproval = isLocalComputerUseServer(config);
		const client = new Client(
			{ name: "tinyfat-agent", version: "1.0.0" },
			{
				capabilities: allowsComputerUseAppApproval
					? { elicitation: { form: {} } }
					: {},
			},
		);

		if (allowsComputerUseAppApproval) {
			client.setRequestHandler(ElicitRequestSchema, async (request) => {
				if (!isComputerUseAppApproval(request.params)) {
					log.logWarning(
						"[mcp-client] Rejected unexpected Computer Use elicitation",
						JSON.stringify(request.params).substring(0, 500),
					);
					return { action: "decline" as const };
				}

				log.logInfo(`[mcp-client] Approved local ${request.params.message}`);
				return { action: "accept" as const, content: {} };
			});
		}

		await client.connect(transport);

		const toolsResult = await client.listTools();
		const tools: AgentTool<any>[] = [];

		for (const mcpTool of toolsResult.tools) {
			tools.push(wrapMcpTool(config.alias, mcpTool, client));
		}

		const source = config.transport === "stdio"
			? `${config.command} ${config.args.join(" ")}`.trim()
			: config.url;
		log.logInfo(`[mcp-client] "${config.alias}": ${tools.length} tools from ${source}`);

		this.servers.push({ alias: config.alias, client, transport, tools });
	}

	tools(): AgentTool<any>[] {
		return this.servers.flatMap((s) => s.tools);
	}

	serverSummary(): string[] {
		return this.servers.map(
			(s) => `${s.alias}: ${s.tools.length} tools (${s.tools.map((t) => t.name).join(", ")})`,
		);
	}

	async disconnect(): Promise<void> {
		for (const server of this.servers) {
			try {
				await server.transport.close();
			} catch {
				// best-effort
			}
		}
		this.servers = [];
		this.connected = false;
	}
}
