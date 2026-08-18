import type { IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "node:crypto";
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

const MAXIMUM_HOST_TOOL_BODY_BYTES = 1024 * 1024;

class HostToolRequestError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const mediaType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
	if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
		throw new HostToolRequestError(415, "JSON required");
	}
	const declaredLength = req.headers["content-length"];
	if (declaredLength !== undefined && (
		Array.isArray(declaredLength)
		|| !/^\d+$/.test(declaredLength)
		|| Number(declaredLength) > MAXIMUM_HOST_TOOL_BODY_BYTES
	)) {
		throw new HostToolRequestError(413, "Request too large");
	}
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += bytes.byteLength;
		if (totalBytes > MAXIMUM_HOST_TOOL_BODY_BYTES) {
			throw new HostToolRequestError(413, "Request too large");
		}
		chunks.push(bytes);
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

function authorizationStatus(req: IncomingMessage, authToken?: string): "authorized" | "disabled" | "unauthorized" {
	if (!authToken || Buffer.byteLength(authToken, "utf8") < 32) return "disabled";
	const header = req.headers["x-tools-token"];
	const provided = Buffer.from(typeof header === "string" ? header : "", "utf8");
	const expected = Buffer.from(authToken, "utf8");
	return provided.length === expected.length && timingSafeEqual(provided, expected)
		? "authorized"
		: "unauthorized";
}

function requireAuthorization(req: IncomingMessage, res: ServerResponse, authToken?: string): boolean {
	const status = authorizationStatus(req, authToken);
	if (status === "authorized") return true;
	writeJson(res, status === "disabled" ? 503 : 401, {
		ok: false,
		error: status === "disabled" ? "Host tool bridge is disabled" : "Unauthorized",
	});
	return false;
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
		if (!requireAuthorization(req, res, options.authToken)) return;

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
				const status = err instanceof HostToolRequestError ? err.status : 500;
				writeJson(res, status, {
					ok: false,
					error: status === 500 ? "Host tool request failed" : err.message,
				});
			});
	};
}

export function createHostToolDefinitionsRoute(options: HostToolExecuteRouteOptions) {
	return (req: IncomingMessage, res: ServerResponse): void => {
		if (!requireAuthorization(req, res, options.authToken)) return;

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
		if (!requireAuthorization(req, res, options.authToken)) return;

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
				const status = err instanceof HostToolRequestError ? err.status : 500;
				writeToolJson(res, status, {
					ok: false,
					error: status === 500 ? "Host tool request failed" : err.message,
				});
			});
	};
}
