import { createServer } from "node:http";
import { bearerMatches, contextCapability } from "./security.mjs";
import { bearerCapability } from "./scoped-app-authorization.mjs";
import { ScopedAppContractError, validateScopedAppEnvelope } from "./scoped-app-contract.mjs";
import { scopedAppGatewayError } from "./scoped-app-gateway.mjs";
import {
	SCOPED_WEBCHAT_ACTIONS,
	ScopedWebchatContractError,
	validateScopedWebchatEnvelope,
} from "./scoped-webchat-contract.mjs";
import { scopedWebchatError } from "./scoped-webchat.mjs";

const RUNTIME_AUTHORIZATION_PATH = /^\/v1\/scoped-app\/runtime\/([^/]+)\/authorize$/;
const RUNTIME_BOUNDARIES = new Set(["model", "tool", "context", "artifact"]);
const MAXIMUM_WEBCHAT_JSON_BYTES = 3 * 1024 * 1024;

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
		not_found: "Not found",
		rate_limited: "Rate limited",
		model_policy_unavailable: "Unavailable",
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

async function readBody(request, maximumBytes, ErrorType = ScopedAppContractError) {
	const declared = request.headers["content-length"];
	if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
		throw new ErrorType();
	}
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximumBytes) throw new ErrorType();
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function webchatPath(config, pathname) {
	const prefix = `${config.webchatPath}/`;
	if (!pathname.startsWith(prefix)) return undefined;
	const action = pathname.slice(prefix.length);
	return SCOPED_WEBCHAT_ACTIONS.includes(action) ? action : undefined;
}

function webchatMediaType(action) {
	return ["events-stream", "live", "messages"].includes(action)
		? "text/event-stream"
		: "application/json";
}

async function proxyWebchatResponse(response, upstream, action) {
	const contentType = upstream.headers.get("content-type") || "";
	const expected = webchatMediaType(action);
	if (!contentType.toLowerCase().startsWith(expected)) {
		await upstream.body?.cancel().catch(() => undefined);
		throw new Error("invalid webchat upstream media type");
	}
	if (expected === "application/json") {
		const declared = upstream.headers.get("content-length");
		if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_WEBCHAT_JSON_BYTES)) {
			await upstream.body?.cancel().catch(() => undefined);
			throw new Error("webchat upstream JSON exceeded its bound");
		}
		const bytes = Buffer.from(await upstream.arrayBuffer());
		if (bytes.length > MAXIMUM_WEBCHAT_JSON_BYTES) {
			throw new Error("webchat upstream JSON exceeded its bound");
		}
		response.writeHead(upstream.status, {
			"content-type": contentType,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		response.end(bytes);
		return;
	}
	response.writeHead(upstream.status, {
		"content-type": contentType,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	if (upstream.body) {
		for await (const chunk of upstream.body) {
			if (!response.write(chunk)) {
				await new Promise((resolvePromise) => response.once("drain", resolvePromise));
			}
		}
	}
	response.end();
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

export function createScopedAppServer({ config, gateway, target, webchat }) {
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

		const webchatAction = scopedConfig.webchatPath
			? webchatPath(scopedConfig, url.pathname)
			: undefined;
		try {
			if (method === "POST" && webchatAction) {
				if (!webchat || !scopedConfig.webchatToken) {
					errorResponse(response, 404, "not_found");
					return;
				}
				if (!isJson(request.headers["content-type"])) {
					errorResponse(response, 400, "invalid");
					return;
				}
				const purpose = bearerCapability(request, { webchat: scopedConfig.webchatToken });
				if (purpose !== "webchat") {
					errorResponse(response, 401, "unauthorized");
					return;
				}
				const body = await readBody(
					request,
					scopedConfig.maximumRequestBytes,
					ScopedWebchatContractError,
				);
				let parsed;
				try {
					parsed = JSON.parse(body.toString("utf8"));
				} catch {
					throw new ScopedWebchatContractError();
				}
				const envelope = validateScopedWebchatEnvelope(parsed, webchatAction);
				if (webchatAction === "bootstrap") {
					json(response, 200, await webchat.bootstrap(envelope));
					return;
				}
				if (webchatAction === "status") {
					json(response, 200, await webchat.status(envelope));
					return;
				}
				if (webchatAction === "messages-stop") {
					json(response, 200, await webchat.stop(envelope));
					return;
				}
				const controller = new AbortController();
				const abort = () => controller.abort(new Error("downstream_closed"));
				request.once("aborted", abort);
				response.once("close", abort);
				let proxy;
				let completed = false;
				try {
					proxy = await webchat.proxy(envelope, webchatAction, controller.signal);
					await proxyWebchatResponse(response, proxy.upstream, webchatAction);
					completed = true;
				} catch (error) {
					if (response.headersSent && !response.writableEnded) {
						if (webchatMediaType(webchatAction) === "text/event-stream") {
							const revoked = proxy?.signal?.reason?.name === "ScopedAppAuthorizationError";
							response.write(`data: ${JSON.stringify({ type: "error", message: revoked ? "authorization_revoked" : "webchat_stream_unavailable" })}\n\n`);
							response.write("data: [DONE]\n\n");
						}
						response.end();
						return;
					}
					throw error;
				} finally {
					await proxy?.close({ completed });
				}
				return;
			}

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
			if (error instanceof ScopedAppContractError || error instanceof ScopedWebchatContractError) {
				errorResponse(response, 400, "invalid");
				return;
			}
			const safe = webchatAction ? scopedWebchatError(error) : scopedAppGatewayError(error);
			errorResponse(response, safe.status, safe.code);
		}
	});
}
