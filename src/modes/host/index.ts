import type { IncomingMessage, ServerResponse } from "http";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RuntimeToolOutputStream } from "../../core/runtime-contract.js";
import type { Executor } from "../../sandbox.js";
import {
	isHostBashRequest,
	isHostToolExecuteRequest,
	type HostBashResponse,
	type HostToolDefinition,
	type HostToolDefinitionsResponse,
	type HostToolExecuteResponse,
} from "./protocol.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const body = Buffer.concat(chunks).toString("utf-8").trim();
	if (!body) return {};
	return JSON.parse(body);
}

function writeJson(res: ServerResponse, status: number, body: HostBashResponse): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body));
}

function writeToolJson(res: ServerResponse, status: number, body: HostToolExecuteResponse): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body));
}

function writeToolDefinitionsJson(res: ServerResponse, status: number, body: HostToolDefinitionsResponse | HostToolExecuteResponse): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body));
}

function writeSseHead(res: ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-store",
		"Connection": "keep-alive",
	});
}

function writeSse(res: ServerResponse, event: unknown): void {
	if (event === "[DONE]") {
		res.write("data: [DONE]\n\n");
		return;
	}
	res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeHostOutput(
	res: ServerResponse,
	event: { stream: RuntimeToolOutputStream; text: string; pid?: number; sequence: number },
): void {
	writeSse(res, { type: "hostToolOutput", ...event });
}

function isAuthorized(req: IncomingMessage, authToken?: string): boolean {
	if (!authToken) return true;
	const provided = req.headers["x-tools-token"];
	return provided === authToken;
}

export interface HostBashRouteOptions {
	executor: Executor;
	authToken?: string;
}

export interface HostToolExecuteRouteOptions {
	tools: () => AgentTool<any>[];
	authToken?: string;
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
		// Fall through to the empty object schema.
	}

	return { type: "object", properties: {}, additionalProperties: false };
}

function toolDefinition(tool: AgentTool<any>): HostToolDefinition {
	return {
		type: "function",
		name: tool.name,
		description: tool.description || tool.name,
		parameters: serializeToolParameters(tool.parameters),
	};
}

export function createHostBashRoute(options: HostBashRouteOptions) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		if (!isAuthorized(req, options.authToken)) {
			writeJson(res, 401, { ok: false, error: "Unauthorized" });
			return;
		}

		readJson(req)
			.then(async (payload) => {
				if (!isHostBashRequest(payload)) {
					writeJson(res, 400, { ok: false, error: "Invalid bash tool request" });
					return;
				}

				if (payload.stream) {
					writeSseHead(res);
					let pid: number | undefined;
					let sequence = 0;
					const result = await options.executor.exec(payload.args.command, {
						timeout: payload.args.timeout,
						onStart: (info) => {
							pid = info.pid;
							writeHostOutput(res, { stream: "system", text: "", pid, sequence: ++sequence });
						},
						onOutput: (chunk) => {
							writeHostOutput(res, { stream: chunk.stream, text: chunk.text, pid, sequence: ++sequence });
						},
					});
					writeSse(res, { type: "hostToolResult", ok: true, result });
					writeSse(res, "[DONE]");
					res.end();
					return;
				}

				const result = await options.executor.exec(payload.args.command, { timeout: payload.args.timeout });
				writeJson(res, 200, { ok: true, result });
			})
			.catch((err) => {
				if (res.headersSent) {
					writeSse(res, { type: "error", error: err instanceof Error ? err.message : String(err) });
					writeSse(res, "[DONE]");
					res.end();
					return;
				}
				writeJson(res, 500, {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	};
}

export function createHostToolDefinitionsRoute(options: HostToolExecuteRouteOptions) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		if (!isAuthorized(req, options.authToken)) {
			writeToolDefinitionsJson(res, 401, { ok: false, error: "Unauthorized" });
			return;
		}

		try {
			writeToolDefinitionsJson(res, 200, {
				ok: true,
				tools: options.tools().map(toolDefinition),
			});
		} catch (err) {
			writeToolDefinitionsJson(res, 500, {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};
}

export function createHostToolExecuteRoute(options: HostToolExecuteRouteOptions) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		if (!isAuthorized(req, options.authToken)) {
			writeToolJson(res, 401, { ok: false, error: "Unauthorized" });
			return;
		}

		readJson(req)
			.then(async (payload) => {
				if (!isHostToolExecuteRequest(payload)) {
					writeToolJson(res, 400, { ok: false, error: "Invalid tool request" });
					return;
				}

				const tool = options.tools().find((candidate) => candidate.name === payload.tool);
				if (!tool) {
					writeToolJson(res, 404, { ok: false, error: `Tool not available: ${payload.tool}` });
					return;
				}

				const args = { ...payload.args };
				if (typeof args.label !== "string" || !args.label.trim()) {
					args.label = `Realtime ${tool.name}`;
				}

				const result = await tool.execute(`realtime-${Date.now()}`, args);
				writeToolJson(res, 200, { ok: true, result });
			})
			.catch((err) => {
				writeToolJson(res, 500, {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	};
}
