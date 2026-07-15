import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Check, Errors } from "typebox/value";
import * as log from "./log.js";
import {
	type ToolOutputEvent,
	withToolOutputStream,
} from "./tools/tool-output-stream.js";

export type ClaudeCliRuntimeToolEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: AgentToolResult<unknown> }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult<unknown>; isError: boolean };

export interface ClaudeCliMcpBridgeOptions {
	tools: AgentTool<any>[];
	onToolEvent?: (event: ClaudeCliRuntimeToolEvent) => void | Promise<void>;
	onToolOutput?: (event: ToolOutputEvent) => void | Promise<void>;
}

export interface ClaudeCliMcpBridge {
	config: {
		mcpServers: {
			troublemaker: {
				type: "http";
				url: string;
				headers: { Authorization: string };
			};
		};
	};
	close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function serializeToolParameters(parameters: unknown): Record<string, unknown> {
	if (!isRecord(parameters)) {
		return { type: "object", properties: {}, additionalProperties: false };
	}
	try {
		const cloned = JSON.parse(JSON.stringify(parameters)) as unknown;
		if (isRecord(cloned)) return cloned;
	} catch {
		// Fall through to a closed empty schema.
	}
	return { type: "object", properties: {}, additionalProperties: false };
}

function errorResult(error: unknown): AgentToolResult<undefined> {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: undefined,
	};
}

async function emitToolEvent(
	sink: ClaudeCliMcpBridgeOptions["onToolEvent"],
	event: ClaudeCliRuntimeToolEvent,
): Promise<void> {
	if (!sink) return;
	try {
		await sink(event);
	} catch (error) {
		log.logWarning("[claude-cli:mcp] Failed to surface tool event", error instanceof Error ? error.message : String(error));
	}
}

function createProtocolServer(options: ClaudeCliMcpBridgeOptions): McpProtocolServer {
	const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
	const server = new McpProtocolServer(
		{ name: "troublemaker", version: "1.0.0" },
		{
			capabilities: { tools: {} },
			instructions:
				"Use these Troublemaker runtime tools for all computer actions and user-visible delivery. " +
				"Use send_message for visible replies and yield_no_action for silent ambient completion.",
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: options.tools.map((tool) => ({
			name: tool.name,
			description: tool.description || tool.name,
			inputSchema: serializeToolParameters(tool.parameters) as any,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const tool = toolsByName.get(request.params.name);
		if (!tool) {
			throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
		}

		const toolCallId = randomUUID();
		let args: unknown = request.params.arguments || {};
		let started = false;
		try {
			if (tool.prepareArguments) args = tool.prepareArguments(args);
			if (!Check(tool.parameters, args)) {
				const issue = Errors(tool.parameters, args)[0];
				const detail = issue ? `${issue.instancePath || "arguments"}: ${issue.message}` : "schema mismatch";
				throw new Error(`Invalid arguments for ${tool.name}: ${detail}`);
			}
			await emitToolEvent(options.onToolEvent, {
				type: "tool_execution_start",
				toolCallId,
				toolName: tool.name,
				args,
			});
			started = true;

			const execute = () => tool.execute(
				toolCallId,
				args as any,
				extra.signal,
				(partialResult) => {
					void emitToolEvent(options.onToolEvent, {
						type: "tool_execution_update",
						toolCallId,
						toolName: tool.name,
						args,
						partialResult,
					});
				},
			);
			const result = options.onToolOutput
				? await withToolOutputStream(options.onToolOutput, execute)
				: await execute();

			await emitToolEvent(options.onToolEvent, {
				type: "tool_execution_end",
				toolCallId,
				toolName: tool.name,
				result,
				isError: false,
			});
			return { content: result.content as any };
		} catch (error) {
			const result = errorResult(error);
			if (started) {
				await emitToolEvent(options.onToolEvent, {
					type: "tool_execution_end",
					toolCallId,
					toolName: tool.name,
					result,
					isError: true,
				});
			}
			return { content: result.content as any, isError: true };
		}
	});

	return server;
}

function closeHttpServer(server: HttpServer): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections?.();
	});
}

export async function startClaudeCliMcpBridge(
	options: ClaudeCliMcpBridgeOptions,
): Promise<ClaudeCliMcpBridge> {
	const token = randomBytes(32).toString("hex");
	const path = `/mcp/${randomBytes(24).toString("hex")}`;
	const httpServer = createServer(async (req, res) => {
		const requestPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
		if (requestPath !== path) {
			res.writeHead(404).end();
			return;
		}
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		const protocolServer = createProtocolServer(options);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await protocolServer.connect(transport);
		try {
			await transport.handleRequest(req, res);
		} catch (error) {
			log.logWarning("[claude-cli:mcp] Request failed", error instanceof Error ? error.message : String(error));
			if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
			if (!res.writableEnded) res.end(JSON.stringify({ error: "Internal error" }));
		} finally {
			await transport.close().catch(() => {});
			await protocolServer.close().catch(() => {});
		}
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", () => {
			httpServer.off("error", reject);
			resolve();
		});
	});
	const address = httpServer.address() as AddressInfo;
	const url = `http://127.0.0.1:${address.port}${path}`;

	return {
		config: {
			mcpServers: {
				troublemaker: {
					type: "http",
					url,
					headers: { Authorization: `Bearer ${token}` },
				},
			},
		},
		close: () => closeHttpServer(httpServer),
	};
}
