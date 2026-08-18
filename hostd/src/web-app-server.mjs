import { createServer } from "node:http";
import { contextCapability, stablePrivateKey } from "./security.mjs";
import { siteDeploymentBindings } from "./runtime.mjs";
import { branchPreviewHostname } from "./sites.mjs";
import { WebAppAssertionVerifier, WebAppAuthError } from "./web-app-auth.mjs";

class WebAppRequestError extends Error {
	constructor(status, code) {
		super(code);
		this.name = "WebAppRequestError";
		this.status = status;
		this.code = code;
	}
}

function json(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

function isJsonContentType(value) {
	if (typeof value !== "string") return false;
	const mediaType = value.split(";", 1)[0].trim().toLowerCase();
	return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readBody(request, maximumBytes) {
	const declaredLength = request.headers["content-length"];
	if (declaredLength !== undefined) {
		if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes) {
			throw new WebAppRequestError(413, "request_too_large");
		}
	}
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximumBytes) throw new WebAppRequestError(413, "request_too_large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function requestedProject(url) {
	if (url.searchParams.getAll("project").length > 1) {
		throw new WebAppRequestError(400, "invalid_project");
	}
	const project = url.searchParams.get("project");
	if (project === null) return undefined;
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) {
		throw new WebAppRequestError(400, "invalid_project");
	}
	return project;
}

function canonicalPrincipalEmail(config, authenticatedEmail) {
	return config.webApp.principalAliases.find((alias) => alias.email === authenticatedEmail)?.principalEmail
		?? authenticatedEmail;
}

function selectPrincipalProject(config, authenticatedEmail, projectSlug) {
	const principalEmail = canonicalPrincipalEmail(config, authenticatedEmail);
	const principal = config.routing.knownPrincipals.find((candidate) => candidate.email === principalEmail);
	if (!principal) throw new WebAppRequestError(403, "principal_not_configured");
	if (projectSlug) {
		if (projectSlug === "intake" && principal.projects.length === 0) {
			return {
				principal,
				project: { slug: "intake", name: "Private intake", siteDeployments: [] },
			};
		}
		const project = principal.projects.find((candidate) => candidate.slug === projectSlug);
		if (!project) throw new WebAppRequestError(404, "project_not_available");
		return { principal, project };
	}
	const configuredDefault = config.webApp.defaultProject
		? principal.projects.find((candidate) => candidate.slug === config.webApp.defaultProject)
		: undefined;
	const project = configuredDefault ?? principal.projects[0] ?? {
		slug: "intake",
		name: "Private intake",
		siteDeployments: [],
	};
	return { principal, project };
}

function validateQuery(url, route) {
	const allowed = new Set(["project"]);
	if (route === "events") {
		allowed.add("limit");
		allowed.add("before");
	}
	if (route === "live") allowed.add("after");
	for (const key of url.searchParams.keys()) {
		if (!allowed.has(key)) throw new WebAppRequestError(400, "invalid_query");
	}
	for (const key of ["limit", "before", "after"]) {
		const values = url.searchParams.getAll(key);
		if (values.length > 1 || (values[0] !== undefined && !/^\d{1,10}$/.test(values[0]))) {
			throw new WebAppRequestError(400, "invalid_query");
		}
	}
}

function resolveScope(state, claims, projectSlug) {
	const { principal, project } = selectPrincipalProject(state.config, claims.email, projectSlug);
	const threadId = stablePrivateKey(
		state.routingKey,
		"web-app-thread",
		`${claims.subject}\n${claims.email}\n${project.slug}`,
	).slice(0, 48);
	const route = state.router.resolve({
		source: "web-app",
		threadId,
		sender: principal.email,
		project: project.slug === "intake" ? undefined : project,
		label: principal.name,
	});
	const target = state.config.targetsById.get(route.targetId);
	if (!target || target.driver !== "oci") {
		throw new WebAppRequestError(503, "workspace_unavailable");
	}
	return { principal, project, route, target };
}

function previewSites(state, scope) {
	const bindings = siteDeploymentBindings(
		state.config,
		state.store,
		scope.target,
		scope.route.contextId,
		state.routingKey,
	);
	return bindings.map((binding) => ({
		slug: binding.siteSlug,
		previewUrl: `https://${binding.previewHostname || branchPreviewHostname(
			binding.siteSlug,
			"main",
			state.config.sites.previewApex,
		)}`,
	}));
}

function sessionPayload(state, claims, scope) {
	const storedContext = state.store.getContext(scope.route.contextId);
	const sites = previewSites(state, scope);
	return {
		user: {
			email: claims.email,
			displayName: scope.principal.name || null,
		},
		agent: {
			name: state.config.webApp.agentName,
			state: storedContext?.status === "online" ? "online" : "sleeping",
		},
		project: {
			slug: scope.project.slug,
			name: scope.project.name,
		},
		projects: scope.principal.projects.length > 0
			? scope.principal.projects.map((project) => ({ slug: project.slug, name: project.name }))
			: [{ slug: "intake", name: "Private intake" }],
		sites,
		capabilities: {
			messages: true,
			awareness: true,
			preview: sites.length > 0,
		},
	};
}

function upstreamPath(route, url) {
	const base = {
		status: "/api/v2/agents/current/status",
		events: "/api/v2/agents/current/events",
		"events-stream": "/api/v2/agents/current/events/stream",
		live: "/api/v2/agents/current/live",
		messages: "/api/v2/agents/current/messages",
		"messages-stop": "/api/v2/agents/current/messages/stop",
	}[route];
	const search = new URLSearchParams();
	for (const key of ["limit", "before", "after"]) {
		const value = url.searchParams.get(key);
		if (value !== null) search.set(key, value);
	}
	return `${base}${search.size ? `?${search}` : ""}`;
}

function normalizedMessageBody(body, scope, route) {
	if (route === "messages-stop") {
		return Buffer.from(JSON.stringify({ channelId: `web-app:${scope.project.slug}` }));
	}
	let parsed;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		throw new WebAppRequestError(400, "invalid_json");
	}
	const message = typeof parsed?.message === "string" ? parsed.message.trim() : "";
	if (!message || Buffer.byteLength(message, "utf8") > 64 * 1024) {
		throw new WebAppRequestError(400, "invalid_message");
	}
	return Buffer.from(JSON.stringify({
		message,
		channelId: `web-app:${scope.project.slug}`,
		source: "web",
		sourceEventType: "tinyfat_app",
	}));
}

async function writeUpstream(response, upstream) {
	const contentType = upstream.headers.get("content-type") || "application/octet-stream";
	const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
	const isJson = mediaType === "application/json" || mediaType.endsWith("+json");
	if (!isJson && mediaType !== "text/event-stream") {
		await upstream.body?.cancel();
		throw new WebAppRequestError(502, "invalid_upstream_response");
	}
	response.writeHead(upstream.status, {
		"content-type": contentType,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...(contentType.startsWith("text/event-stream") ? {
			connection: "keep-alive",
			"x-accel-buffering": "no",
		} : {}),
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

const ROUTES = new Map([
	["GET /v1/app/session", "session"],
	["GET /v1/app/status", "status"],
	["GET /v1/app/events", "events"],
	["GET /v1/app/events/stream", "events-stream"],
	["GET /v1/app/live", "live"],
	["POST /v1/app/messages", "messages"],
	["POST /v1/app/messages/stop", "messages-stop"],
]);

export function createWebAppServer(state, { fetchImpl = fetch, verifier } = {}) {
	if (!state.config.webApp) throw new Error("webApp is not configured");
	const assertionVerifier = verifier ?? new WebAppAssertionVerifier(state.config.webApp);
	return createServer(async (request, response) => {
		const method = request.method || "GET";
		const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
		if (method === "GET" && url.pathname === "/health") {
			response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
			response.end("ok");
			return;
		}
		const route = ROUTES.get(`${method} ${url.pathname}`);
		if (!route) {
			json(response, 404, { error: "not_found" });
			return;
		}

		try {
			validateQuery(url, route);
			if (
				method === "POST"
				&& !isJsonContentType(request.headers["content-type"])
			) {
				throw new WebAppRequestError(415, "json_required");
			}
			const body = await readBody(request, state.config.webApp.maximumRequestBytes);
			const claims = assertionVerifier.verify({
				headers: request.headers,
				method,
				path: request.url || "/",
				body,
			});
			const scope = resolveScope(state, claims, requestedProject(url));
			if (route === "session") {
				json(response, 200, sessionPayload(state, claims, scope));
				return;
			}

			const runtime = await state.runtime.ensureOciContext(scope.target, scope.route.contextId);
			const outboundBody = method === "POST"
				? normalizedMessageBody(body, scope, route)
				: undefined;
			const controller = new AbortController();
			const abortIfIncomplete = () => {
				if (!response.writableEnded) controller.abort();
			};
			request.once("aborted", () => controller.abort());
			response.once("close", abortIfIncomplete);
			try {
				const upstream = await fetchImpl(
					`http://127.0.0.1:${runtime.port}${upstreamPath(route, url)}`,
					{
						method,
						headers: {
							accept: request.headers.accept || "application/json",
							...(method === "POST" ? {
								authorization: `Bearer ${contextCapability(
									scope.target.inboundToken,
									"web-app",
									scope.route.contextId,
								)}`,
								"content-type": "application/json",
							} : {}),
						},
						body: outboundBody,
						signal: controller.signal,
					},
				);
				await writeUpstream(response, upstream);
			} finally {
				response.off("close", abortIfIncomplete);
			}
		} catch (error) {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			if (error instanceof WebAppAuthError) {
				json(response, 401, { error: "unauthorized" });
				return;
			}
			if (error instanceof WebAppRequestError) {
				json(response, error.status, { error: error.code });
				return;
			}
			console.error(
				"troublemaker-hostd: web app request failed:",
				error instanceof Error ? error.message : String(error),
			);
			json(response, 503, { error: "workspace_unavailable" });
		}
	});
}
