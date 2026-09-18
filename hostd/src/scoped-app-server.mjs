import { createServer } from "node:http";
import { bearerMatches, contextCapability } from "./security.mjs";
import { bearerCapability } from "./scoped-app-authorization.mjs";
import { ScopedAppContractError, validateScopedAppEnvelope } from "./scoped-app-contract.mjs";
import { scopedAppGatewayError } from "./scoped-app-gateway.mjs";

const RUNTIME_AUTHORIZATION_PATH = /^\/v1\/scoped-app\/runtime\/([^/]+)\/authorize$/;
const RUNTIME_BOUNDARIES = new Set(["model", "tool", "context", "artifact"]);

function json(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

function errorMessage(code) {
	return {
		unauthorized: "Unauthorized",
		forbidden: "Forbidden",
		conflict: "Conflict",
		unavailable: "Unavailable",
		invalid: "Invalid request",
		rate_limited: "Rate limited",
	}[code] ?? "Unavailable";
}

function errorResponse(response, status, code) {
	json(response, status, { error: { code, message: errorMessage(code) } });
}

function isJson(value) {
	if (typeof value !== "string") return false;
	const mediaType = value.split(";", 1)[0].trim().toLowerCase();
	return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readBody(request, maximumBytes) {
	const declared = request.headers["content-length"];
	if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
		throw new ScopedAppContractError();
	}
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximumBytes) throw new ScopedAppContractError();
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function parseRuntimeAuthorization(body) {
	let parsed;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		throw new ScopedAppContractError();
	}
	if (
		!parsed
		|| typeof parsed !== "object"
		|| Array.isArray(parsed)
		|| Object.keys(parsed).sort().join(",") !== "boundary,version"
		|| parsed.version !== "1"
		|| !RUNTIME_BOUNDARIES.has(parsed.boundary)
	) throw new ScopedAppContractError();
	return parsed;
}

export function createScopedAppServer({ config, gateway, target }) {
	if (!config?.scopedApp) throw new Error("scopedApp is not configured");
	const scopedConfig = config.scopedApp;
	return createServer(async (request, response) => {
		const method = request.method || "GET";
		const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
		if (method === "GET" && url.pathname === "/health") {
			response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
			response.end("ok");
			return;
		}
		if (request.headers.origin) {
			errorResponse(response, 403, "forbidden");
			return;
		}

		try {
			if (method === "POST" && url.pathname === scopedConfig.dispatchPath) {
				if (!isJson(request.headers["content-type"])) {
					errorResponse(response, 400, "invalid");
					return;
				}
				const purpose = bearerCapability(request, {
					dispatch: scopedConfig.dispatchToken,
					revoke: scopedConfig.revokeToken,
				});
				if (!purpose) {
					errorResponse(response, 401, "unauthorized");
					return;
				}
				const body = await readBody(request, scopedConfig.maximumRequestBytes);
				let parsed;
				try {
					parsed = JSON.parse(body.toString("utf8"));
				} catch {
					throw new ScopedAppContractError();
				}
				const envelope = validateScopedAppEnvelope(parsed);
				json(response, 200, await gateway.dispatch(envelope, purpose, body.toString("utf8")));
				return;
			}

			const runtimeMatch = url.pathname.match(RUNTIME_AUTHORIZATION_PATH);
			if (method === "POST" && runtimeMatch) {
				if (!isJson(request.headers["content-type"])) {
					errorResponse(response, 400, "invalid");
					return;
				}
				const contextId = decodeURIComponent(runtimeMatch[1]);
				const expected = contextCapability(
					target.inboundToken,
					"scoped-app-runtime-authorization",
					contextId,
				);
				if (!bearerMatches(request.headers.authorization, expected)) {
					errorResponse(response, 401, "unauthorized");
					return;
				}
				parseRuntimeAuthorization(await readBody(request, 1024));
				json(response, 200, await gateway.authorizeRuntime(contextId));
				return;
			}

			errorResponse(response, 404, "invalid");
		} catch (error) {
			if (error instanceof ScopedAppContractError) {
				errorResponse(response, 400, "invalid");
				return;
			}
			const safe = scopedAppGatewayError(error);
			errorResponse(response, safe.status, safe.code);
		}
	});
}
