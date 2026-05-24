import type { IncomingMessage, ServerResponse } from "http";
import type { RuntimeToolOutputStream } from "../../core/runtime-contract.js";
import type { Executor } from "../../sandbox.js";
import { isHostBashRequest, type HostBashResponse } from "./protocol.js";

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
