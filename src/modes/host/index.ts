import type { IncomingMessage, ServerResponse } from "http";
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

				const result = await options.executor.exec(payload.args.command, {
					timeout: payload.args.timeout,
				});
				writeJson(res, 200, { ok: true, result });
			})
			.catch((err) => {
				writeJson(res, 500, {
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	};
}
