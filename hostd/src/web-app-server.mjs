import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contextCapability, stablePrivateKey } from "./security.mjs";
import {
	contextWorkspacePath,
	readComputerControlState,
	siteDeploymentBindings,
	writeComputerControlState,
} from "./runtime.mjs";
import { branchPreviewHostname } from "./sites.mjs";
import { WebAppAssertionVerifier, WebAppAuthError } from "./web-app-auth.mjs";

const DEFAULT_WEB_APP_UI_DIRECTORY = fileURLToPath(new URL("../../ui/dist/", import.meta.url));
const WEB_APP_UI_ASSET_RE = /^\/v1\/app\/ui\/assets\/([a-zA-Z0-9._-]+)$/;
const WEB_APP_UI_CONTENT_TYPES = new Map([
	[".css", "text/css; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
]);

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

function requestedUiAsset(method, pathname) {
	if (method !== "GET") return null;
	if (pathname === "/v1/app/ui" || pathname === "/v1/app/ui/" || pathname === "/v1/app/ui/index.html") {
		return { file: "index.html", index: true };
	}
	const match = pathname.match(WEB_APP_UI_ASSET_RE);
	return match ? { file: join("assets", match[1]), index: false } : null;
}

async function writeUiAsset(response, uiDirectory, asset) {
	let content;
	try {
		content = await readFile(join(uiDirectory, asset.file));
	} catch (error) {
		if (error?.code === "ENOENT") throw new WebAppRequestError(404, "ui_asset_not_found");
		throw error;
	}
	const contentType = asset.index
		? "text/html; charset=utf-8"
		: WEB_APP_UI_CONTENT_TYPES.get(extname(asset.file).toLowerCase());
	if (!contentType) throw new WebAppRequestError(404, "ui_asset_not_found");
	response.writeHead(200, {
		"content-type": contentType,
		"cache-control": asset.index ? "no-store" : "private, max-age=31536000, immutable",
		"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
		"cross-origin-resource-policy": "same-origin",
		"x-content-type-options": "nosniff",
	});
	response.end(content);
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

function selectAccountBinding(config, claims) {
	const binding = config.webApp.accountBindings.find((candidate) => (
		candidate.accountEmail === claims.email
			&& candidate.subject === claims.subject
			&& candidate.agent.id === claims.agent
	));
	if (!binding) throw new WebAppRequestError(403, "account_not_configured");
	return binding;
}

function selectPrincipalProject(config, binding, projectSlug) {
	if (binding.principalPhone) {
		const configured = config.routing.knownPhonePrincipals.find(
			(candidate) => candidate.phone === binding.principalPhone,
		);
		if (!configured) throw new WebAppRequestError(403, "principal_not_configured");
		if (projectSlug && projectSlug !== "intake") {
			throw new WebAppRequestError(404, "project_not_available");
		}
		return {
			principal: {
				...configured,
				channel: "phone",
				projects: [],
			},
			project: { slug: "intake", name: "Private relationship", siteDeployments: [] },
		};
	}
	const principal = config.routing.knownPrincipals.find((candidate) => candidate.email === binding.principalEmail);
	if (!principal) throw new WebAppRequestError(403, "principal_not_configured");
	const selectedPrincipal = { ...principal, channel: "email" };
	if (projectSlug) {
		if (projectSlug === "intake" && principal.projects.length === 0) {
			return {
				principal: selectedPrincipal,
				project: { slug: "intake", name: "Private intake", siteDeployments: [] },
			};
		}
		const project = principal.projects.find((candidate) => candidate.slug === projectSlug);
		if (!project) throw new WebAppRequestError(404, "project_not_available");
		return { principal: selectedPrincipal, project };
	}
	const configuredDefault = config.webApp.defaultProject
		? principal.projects.find((candidate) => candidate.slug === config.webApp.defaultProject)
		: undefined;
	const project = configuredDefault ?? principal.projects[0] ?? {
		slug: "intake",
		name: "Private intake",
		siteDeployments: [],
	};
	return { principal: selectedPrincipal, project };
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
	const binding = selectAccountBinding(state.config, claims);
	const { principal, project } = selectPrincipalProject(state.config, binding, projectSlug);
	let route;
	if (binding.principalPhone) {
		const principalHash = stablePrivateKey(
			state.routingKey,
			"phone-principal",
			binding.principalPhone,
		);
		const routes = state.store.listRoutesForPrincipal(
			"phone",
			principalHash,
			binding.agent.targetId,
		);
		const contexts = new Set(routes.map((candidate) => candidate.contextId));
		if (routes.length === 0) throw new WebAppRequestError(409, "relationship_not_ready");
		if (contexts.size !== 1) throw new WebAppRequestError(409, "relationship_ambiguous");
		route = routes[0];
		if (
			route.principalHash !== principalHash
			|| route.targetId !== binding.agent.targetId
			|| route.projectSlug !== "intake"
			|| !state.store.getContext(route.contextId)
		) throw new WebAppRequestError(409, "relationship_not_ready");
	} else {
		const threadId = stablePrivateKey(
			state.routingKey,
			"web-app-thread",
			`${binding.agent.id}\n${claims.subject}\n${claims.email}\n${project.slug}`,
		).slice(0, 48);
		route = state.router.resolve({
			source: "web-app",
			threadId,
			sender: principal.email,
			project: project.slug === "intake" ? undefined : project,
			label: principal.name,
			targetId: binding.agent.targetId,
		});
	}
	const target = state.config.targetsById.get(route.targetId);
	if (!target || target.driver !== "oci") {
		throw new WebAppRequestError(503, "workspace_unavailable");
	}
	return { binding, principal, project, route, target };
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
			role: scope.binding.role,
		},
		principal: {
			channel: scope.principal.channel,
			email: scope.principal.email ?? null,
			displayName: scope.principal.name || null,
		},
		agent: {
			id: scope.binding.agent.id,
			name: scope.binding.agent.name,
			slug: scope.binding.agent.slug,
			email: scope.binding.agent.email,
			state: storedContext?.status === "online" ? "online" : "sleeping",
		},
		project: {
			slug: scope.project.slug,
			name: scope.project.name,
		},
		projects: scope.principal.projects.length > 0
			? scope.principal.projects.map((project) => ({ slug: project.slug, name: project.name }))
			: [{ slug: scope.project.slug, name: scope.project.name }],
		sites,
		capabilities: {
			messages: true,
			awareness: true,
			desktop: scope.target.computer?.enabled === true,
			takeover: scope.target.computer?.enabled === true && scope.binding.role !== "viewer",
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

// WebsitePaint: a settled canvas is a PNG, base64 in JSON.
export const CANVAS_MAXIMUM_PNG_BYTES = 4 * 1024 * 1024;
const CANVAS_MAXIMUM_PROMPT_BYTES = 4 * 1024;
// base64 of the PNG cap plus the prompt and JSON framing.
export const CANVAS_MAXIMUM_REQUEST_BYTES = Math.ceil(CANVAS_MAXIMUM_PNG_BYTES / 3) * 4 + 64 * 1024;
const CANVAS_MAXIMUM_SIDE = 4096;
const CANVAS_MAXIMUM_PIXELS = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Walk every chunk: IHDR first with bounded dimensions, valid CRCs, IDAT present, IEND last. */
export function validatedPng(png) {
	const fail = () => {
		throw new WebAppRequestError(400, "invalid_canvas");
	};
	if (png.length < 8 + 25 + 12 || png.length > CANVAS_MAXIMUM_PNG_BYTES) fail();
	if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) fail();
	let offset = 8;
	let index = 0;
	let sawIdat = false;
	let dimensions;
	while (offset < png.length) {
		if (offset + 12 > png.length) fail();
		const length = png.readUInt32BE(offset);
		const type = png.toString("latin1", offset + 4, offset + 8);
		if (!/^[A-Za-z]{4}$/.test(type) || length > png.length - offset - 12) fail();
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)) fail();
		if (index === 0) {
			if (type !== "IHDR" || length !== 13) fail();
			const width = data.readUInt32BE(0);
			const height = data.readUInt32BE(4);
			if (
				width < 1 || height < 1
				|| width > CANVAS_MAXIMUM_SIDE || height > CANVAS_MAXIMUM_SIDE
				|| width * height > CANVAS_MAXIMUM_PIXELS
			) fail();
			dimensions = { width, height };
		} else if (type === "IHDR") {
			fail();
		}
		if (type === "IDAT") sawIdat = true;
		offset += 12 + length;
		index += 1;
		if (type === "IEND") {
			if (length !== 0 || offset !== png.length || !sawIdat) fail();
			return dimensions;
		}
	}
	return fail();
}

export function parsedCanvasBody(body) {
	let parsed;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		throw new WebAppRequestError(400, "invalid_json");
	}
	if (
		!parsed
		|| typeof parsed !== "object"
		|| Array.isArray(parsed)
		|| Object.keys(parsed).some((key) => key !== "png_base64" && key !== "prompt")
		|| typeof parsed.png_base64 !== "string"
		|| (parsed.prompt !== undefined && typeof parsed.prompt !== "string")
	) {
		throw new WebAppRequestError(400, "invalid_canvas");
	}
	const png = Buffer.from(parsed.png_base64, "base64");
	// Canonical base64 only: no whitespace, URL alphabet, or loose padding.
	if (png.toString("base64") !== parsed.png_base64) throw new WebAppRequestError(400, "invalid_canvas");
	validatedPng(png);
	const prompt = (parsed.prompt ?? "").trim();
	if (Buffer.byteLength(prompt, "utf8") > CANVAS_MAXIMUM_PROMPT_BYTES) {
		throw new WebAppRequestError(400, "invalid_canvas");
	}
	return { png, prompt };
}

/** Workspace-relative canvas location for one project; slug is already validated. */
export function canvasRelativePath(projectSlug) {
	return `websitepaint/${projectSlug}/latest.png`;
}

async function writeCanvas(target, contextId, projectSlug, png) {
	const path = join(contextWorkspacePath(target, contextId), canvasRelativePath(projectSlug));
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	let file;
	try {
		file = await open(temporaryPath, "wx", 0o600);
		await file.writeFile(png);
		await file.close();
		file = undefined;
		await rename(temporaryPath, path);
	} catch (error) {
		await file?.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

export function canvasMessage(projectSlug, prompt) {
	const message = `[WebsitePaint] The canvas settled. Look at ${canvasRelativePath(projectSlug)} in your workspace `
		+ "(read the image) and keep building this project's website to match it: "
		+ "layout, colors and blocks as painted. When the page is coherent, update the project and deploy "
		+ "the review preview with the existing site deployment so the painter sees it.";
	return prompt ? `${message}\n\nNotes from the painter: ${prompt}` : message;
}

function requestedComputerControl(body) {
	let parsed;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		throw new WebAppRequestError(400, "invalid_json");
	}
	if (
		!parsed
		|| typeof parsed !== "object"
		|| Array.isArray(parsed)
		|| Object.keys(parsed).some((key) => key !== "mode")
		|| !["agent", "human"].includes(parsed.mode)
	) {
		throw new WebAppRequestError(400, "invalid_computer_control");
	}
	return parsed.mode;
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
	["POST /v1/app/canvas", "canvas"],
	["GET /v1/app/desktop/status", "desktop-status"],
	["POST /v1/app/desktop/control", "desktop-control"],
]);

function writeUpgradeError(socket, status, reason) {
	if (socket.destroyed) return;
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`);
	socket.destroy();
}

function forwardUpgradeHeaders(request, upstream, port, authorization) {
	upstream.write("GET /desktop/socket HTTP/1.1\r\n");
	upstream.write(`Host: 127.0.0.1:${port}\r\n`);
	upstream.write("Connection: Upgrade\r\n");
	upstream.write("Upgrade: websocket\r\n");
	upstream.write(`Authorization: Bearer ${authorization}\r\n`);
	for (const header of [
		"sec-websocket-key",
		"sec-websocket-version",
		"sec-websocket-protocol",
		"sec-websocket-extensions",
	]) {
		const value = request.headers[header];
		if (value) upstream.write(`${header}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`);
	}
	upstream.write("\r\n");
}

export function createWebAppServer(state, {
	fetchImpl = fetch,
	verifier,
	uiDirectory = DEFAULT_WEB_APP_UI_DIRECTORY,
} = {}) {
	if (!state.config.webApp) throw new Error("webApp is not configured");
	const assertionVerifier = verifier ?? new WebAppAssertionVerifier(state.config.webApp);
	const desktopConnections = new Map();
	const humanLeases = new Map();
	state.runtime.setExternalActivityProbe?.((contextId) => (
		(desktopConnections.get(contextId) ?? 0) > 0
			|| (humanLeases.get(contextId) ?? 0) > Date.now()
	));
	const server = createServer(async (request, response) => {
		const method = request.method || "GET";
		const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
		if (method === "GET" && url.pathname === "/health") {
			response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
			response.end("ok");
			return;
		}
		const uiAsset = requestedUiAsset(method, url.pathname);
		const route = uiAsset ? "ui" : ROUTES.get(`${method} ${url.pathname}`);
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
			const body = await readBody(
				request,
				route === "canvas"
					? Math.max(CANVAS_MAXIMUM_REQUEST_BYTES, state.config.webApp.maximumRequestBytes)
					: state.config.webApp.maximumRequestBytes,
			);
			const claims = assertionVerifier.verify({
				headers: request.headers,
				method,
				path: request.url || "/",
				body,
			});
			if (uiAsset) {
				const binding = selectAccountBinding(state.config, claims);
				if (uiAsset.index) selectPrincipalProject(state.config, binding, requestedProject(url));
				await writeUiAsset(response, uiDirectory, uiAsset);
				return;
			}
			const scope = resolveScope(state, claims, requestedProject(url));
			if (route === "session") {
				json(response, 200, sessionPayload(state, claims, scope));
				return;
			}
			if ((route === "desktop-status" || route === "desktop-control") && !scope.target.computer?.enabled) {
				throw new WebAppRequestError(404, "desktop_not_available");
			}

			const runtime = await state.runtime.ensureOciContext(scope.target, scope.route.contextId);
			if (route === "desktop-status") {
				const control = await readComputerControlState(scope.target, scope.route.contextId);
				if (control.mode === "human") humanLeases.set(scope.route.contextId, Date.parse(control.expiresAt));
				else humanLeases.delete(scope.route.contextId);
				json(response, 200, {
					state: "ready",
					control: control.mode,
					expiresAt: control.expiresAt,
					canTakeOver: scope.binding.role !== "viewer",
				});
				return;
			}
			if (route === "desktop-control") {
				if (scope.binding.role === "viewer") throw new WebAppRequestError(403, "takeover_not_allowed");
				const mode = requestedComputerControl(body);
				const control = await writeComputerControlState(scope.target, scope.route.contextId, mode);
				if (mode === "human") {
					humanLeases.set(scope.route.contextId, Date.parse(control.expiresAt));
					await fetchImpl(`http://127.0.0.1:${runtime.port}/api/v2/agents/current/messages/stop`, {
						method: "POST",
						headers: {
							authorization: `Bearer ${contextCapability(
								scope.target.inboundToken,
								"web-app",
								scope.route.contextId,
							)}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ channelId: `web-app:${scope.project.slug}` }),
						signal: AbortSignal.timeout(5_000),
					}).catch(() => undefined);
				} else {
					humanLeases.delete(scope.route.contextId);
				}
				json(response, 200, {
					control: control.mode,
					expiresAt: control.expiresAt,
				});
				return;
			}
			let upstreamRoute = route;
			let outboundBody;
			if (route === "canvas") {
				if (scope.binding.role === "viewer") throw new WebAppRequestError(403, "canvas_not_allowed");
				const canvas = parsedCanvasBody(body);
				await writeCanvas(scope.target, scope.route.contextId, scope.project.slug, canvas.png);
				upstreamRoute = "messages";
				outboundBody = normalizedMessageBody(
					Buffer.from(JSON.stringify({ message: canvasMessage(scope.project.slug, canvas.prompt) })),
					scope,
					"messages",
				);
			} else if (method === "POST") {
				outboundBody = normalizedMessageBody(body, scope, route);
			}
			const controller = new AbortController();
			const abortIfIncomplete = () => {
				if (!response.writableEnded) controller.abort();
			};
			if (route !== "canvas") request.once("aborted", () => controller.abort());
			response.once("close", abortIfIncomplete);
			try {
				const upstream = await fetchImpl(
					`http://127.0.0.1:${runtime.port}${upstreamPath(upstreamRoute, url)}`,
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
				if (route === "canvas") {
					// The turn keeps running; the painter only needs to know it was accepted.
					// Drain the turn stream in the background so the runtime never blocks on it.
					response.off("close", abortIfIncomplete);
					if (upstream.ok) {
						void (async () => {
							try {
								for await (const _ of upstream.body ?? []) { /* drain */ }
							} catch { /* turn stream closed */ }
						})();
						json(response, 202, { status: "started" });
					} else {
						await upstream.body?.cancel();
						json(response, upstream.status === 409 ? 409 : 502, {
							error: upstream.status === 409 ? "busy" : "invalid_upstream_response",
						});
					}
					return;
				}
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

	server.on("upgrade", async (request, socket, head) => {
		try {
			const method = request.method || "GET";
			const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
			if (
				method !== "GET"
				|| url.pathname !== "/v1/app/desktop/socket"
				|| String(request.headers.upgrade || "").toLowerCase() !== "websocket"
			) {
				writeUpgradeError(socket, 404, "Not Found");
				return;
			}
			validateQuery(url, "desktop-socket");
			const claims = assertionVerifier.verify({
				headers: request.headers,
				method,
				path: request.url || "/",
				body: Buffer.alloc(0),
			});
			const scope = resolveScope(state, claims, requestedProject(url));
			if (!scope.target.computer?.enabled) throw new WebAppRequestError(404, "desktop_not_available");
			const runtime = await state.runtime.ensureOciContext(scope.target, scope.route.contextId);
			const upstream = connectSocket(runtime.port, "127.0.0.1");
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				const count = Math.max(0, (desktopConnections.get(scope.route.contextId) ?? 1) - 1);
				if (count === 0) desktopConnections.delete(scope.route.contextId);
				else desktopConnections.set(scope.route.contextId, count);
			};
			desktopConnections.set(
				scope.route.contextId,
				(desktopConnections.get(scope.route.contextId) ?? 0) + 1,
			);
			upstream.once("connect", () => {
				forwardUpgradeHeaders(
					request,
					upstream,
					runtime.port,
					contextCapability(scope.target.inboundToken, "web-app", scope.route.contextId),
				);
				if (head.length > 0) upstream.write(head);
				socket.pipe(upstream).pipe(socket);
			});
			upstream.once("error", () => {
				release();
				writeUpgradeError(socket, 502, "Bad Gateway");
			});
			upstream.once("close", release);
			socket.once("close", release);
			socket.once("error", () => upstream.destroy());
		} catch (error) {
			if (error instanceof WebAppAuthError) writeUpgradeError(socket, 401, "Unauthorized");
			else if (error instanceof WebAppRequestError) writeUpgradeError(socket, error.status, "Rejected");
			else writeUpgradeError(socket, 503, "Service Unavailable");
		}
	});

	return server;
}
