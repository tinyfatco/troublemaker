import { createServer } from "node:http";
import { McpEdgeAssertionVerifier, McpEdgeAuthError } from "./mcp-edge-auth.mjs";
import { HostMcpError } from "./mcp.mjs";

async function readBody(request, maximumBytes) {
	const declared = request.headers["content-length"];
	if (typeof declared === "string" && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
		throw new HostMcpError("request_too_large", 413);
	}
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximumBytes) throw new HostMcpError("request_too_large", 413);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function json(response, status, body, headers = {}) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...headers,
	});
	response.end(JSON.stringify(body));
}

function bearer(header) {
	const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
	return match?.[1] || "";
}

async function proxyFetchResponse(response, upstream) {
	const headers = {
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	};
	for (const name of ["content-type", "mcp-session-id", "retry-after", "www-authenticate"]) {
		const value = upstream.headers.get(name);
		if (value) headers[name] = value;
	}
	response.writeHead(upstream.status, headers);
	if (upstream.body) {
		for await (const chunk of upstream.body) {
			if (!response.write(chunk)) {
				await new Promise((resolvePromise) => response.once("drain", resolvePromise));
			}
		}
	}
	response.end();
}

export function createMcpEdgeServer({ config, mcp, store }) {
	if (!config.mcp) throw new Error("MCP edge configuration is required");
	const verifier = new McpEdgeAssertionVerifier(config.mcp.edge, {
		consumeNonce: store
			? (issuer, nonce, expiresAt) => store.consumeMcpEdgeNonce(issuer, nonce, expiresAt)
			: undefined,
	});
	return createServer(async (request, response) => {
		const path = request.url || "/";
		const url = new URL(path, `http://${request.headers.host || "localhost"}`);
		try {
			if (request.method === "GET" && url.pathname === "/health") {
				response.writeHead(200, {
					"content-type": "text/plain",
					"cache-control": "no-store",
				});
				response.end("ok");
				return;
			}
			if (request.method !== "POST") throw new HostMcpError("not_found", 404);
			const body = await readBody(request, config.mcp.maximumRequestBytes);

			const resourceMatch = url.pathname.match(/^\/v1\/mcp\/resources\/([^/]+)$/);
			if (resourceMatch) {
				verifier.verify({
					headers: request.headers,
					method: request.method,
					path,
					body,
					allowedIssuers: ["crawdad-cf"],
				});
				const upstream = await mcp.proxyInbound({
					resourceId: decodeURIComponent(resourceMatch[1]),
					authorization: request.headers.authorization,
					body,
					requestHeaders: request.headers,
				});
				await proxyFetchResponse(response, upstream);
				return;
			}

			if (url.pathname === "/v1/mcp/handoffs/session") {
				verifier.verify({
					headers: request.headers,
					method: request.method,
					path,
					body,
					allowedIssuers: ["fat-platform"],
				});
				json(response, 200, mcp.openHandoff(bearer(request.headers.authorization)));
				return;
			}

			if (url.pathname === "/v1/mcp/handoffs/complete") {
				verifier.verify({
					headers: request.headers,
					method: request.method,
					path,
					body,
					allowedIssuers: ["fat-platform"],
				});
				let input;
				try {
					input = JSON.parse(body.toString("utf8"));
				} catch {
					throw new HostMcpError("json_required");
				}
				if (!input || typeof input !== "object" || Array.isArray(input)) {
					throw new HostMcpError("json_required");
				}
				json(
					response,
					200,
					await mcp.completeHandoff(bearer(request.headers.authorization), input),
				);
				return;
			}
			throw new HostMcpError("not_found", 404);
		} catch (error) {
			if (response.headersSent) {
				response.destroy(error instanceof Error ? error : undefined);
				return;
			}
			if (error instanceof McpEdgeAuthError) {
				json(response, 401, { error: error.code });
				return;
			}
			if (error instanceof HostMcpError) {
				json(response, error.status, { error: error.code });
				return;
			}
			console.error(`troublemaker-hostd: MCP edge request failed (${url.pathname}):`, error);
			json(response, 500, { error: "internal_error" });
		}
	});
}
