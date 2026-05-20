import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "http";
import { connect as connectSocket, type Socket } from "net";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { join, extname, resolve, normalize } from "path";
import { ConsoleError, ConsoleService } from "./console/service.js";
import * as log from "./log.js";
import { FilesystemAwarenessStore } from "./storage/node/filesystem-awareness.js";
import { FilesystemWorkspaceStore } from "./storage/node/filesystem-workspace.js";

/**
 * Gateway — single HTTP server with path-based routing.
 * Serves adapter webhooks, API routes, and optionally a static web UI.
 */

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".map": "application/json",
};

interface PreviewProxyTarget {
	port: number;
	path: string;
}

function parsePreviewProxyTarget(rawUrl: string): PreviewProxyTarget | null {
	const url = new URL(rawUrl || "/", "http://localhost");
	const match = url.pathname.match(/^\/preview\/(\d{4,5})(\/.*)?$/);
	if (!match) return null;
	const port = Number.parseInt(match[1], 10);
	if (!Number.isFinite(port) || port < 1024 || port > 65535 || port === 3000 || port === 3002) {
		return null;
	}
	return {
		port,
		path: `${match[2] || "/"}${url.search}`,
	};
}

function previewProxyHeaders(req: IncomingMessage, port: number): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		const normalized = key.toLowerCase();
		if (
			normalized === "connection" ||
			normalized === "host" ||
			normalized === "keep-alive" ||
			normalized === "proxy-connection" ||
			normalized === "transfer-encoding" ||
			normalized === "upgrade"
		) {
			continue;
		}
		headers[key] = value;
	}
	headers.host = `127.0.0.1:${port}`;
	headers["x-forwarded-host"] = req.headers.host || "localhost";
	headers["x-forwarded-proto"] = "http";
	return headers;
}

export interface GatewayOptions {
	/** Directory containing built static files (index.html, assets/) */
	uiDir?: string;
	/** Directory to scope file API reads to */
	workspaceDir?: string;
}

export type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => void;

export class Gateway {
	private routes = new Map<string, RouteHandler>();
	private getRoutes = new Map<string, RouteHandler>();
	private upgradeRoutes = new Map<string, UpgradeHandler>();
	private readyRoutes = new Set<string>();
	private server: Server | null = null;
	private uiDir: string | null = null;
	private workspaceDir: string | null = null;
	private consoleService: ConsoleService | null = null;
	private awarenessStore: FilesystemAwarenessStore | null = null;
	/** Connected SSE clients for /awareness/stream */
	private awarenessClients = new Set<ServerResponse>();
	private awarenessWatcher: ReturnType<typeof setInterval> | null = null;
	private awarenessFileSize = 0;

	constructor(options: GatewayOptions = {}) {
		if (options.uiDir && existsSync(options.uiDir)) {
			this.uiDir = resolve(options.uiDir);
			log.logInfo(`[gateway] serving UI from ${this.uiDir}`);
		}
		if (options.workspaceDir) {
			this.workspaceDir = resolve(options.workspaceDir);
			this.consoleService = new ConsoleService(new FilesystemWorkspaceStore(this.workspaceDir));
			this.awarenessStore = new FilesystemAwarenessStore(this.workspaceDir);
		}
	}

	/** Register a POST route handler (e.g., "/slack/events" → adapter.dispatch) */
	register(path: string, handler: RouteHandler): void {
		this.routes.set(path, handler);
		log.logInfo(`[gateway] registered route: POST ${path}`);
	}

	/** Register a GET route handler (e.g., "/schedule") */
	registerGet(path: string, handler: RouteHandler): void {
		this.getRoutes.set(path, handler);
		log.logInfo(`[gateway] registered route: GET ${path}`);
	}

	/** Register a WebSocket upgrade handler (e.g., "/voice/stream") */
	registerUpgrade(path: string, handler: UpgradeHandler): void {
		this.upgradeRoutes.set(path, handler);
		log.logInfo(`[gateway] registered route: UPGRADE ${path}`);
	}

	/** Mark a route as ready to accept traffic. Until called, the route returns 503. */
	markReady(path: string): void {
		this.readyRoutes.add(path);
		log.logInfo(`[gateway] adapter ready: POST ${path}`);
	}

	/** Serve a static file from uiDir */
	private serveStatic(filePath: string, res: ServerResponse): void {
		try {
			const content = readFileSync(filePath);
			const ext = extname(filePath);
			const contentType = MIME_TYPES[ext] || "application/octet-stream";
			res.writeHead(200, { "Content-Type": contentType });
			res.end(content);
		} catch {
			res.writeHead(404);
			res.end("Not found");
		}
	}

	private requireConsoleService(res: ServerResponse): ConsoleService | null {
		if (!this.consoleService) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No workspace configured" }));
			return null;
		}
		return this.consoleService;
	}

	private sendConsoleError(res: ServerResponse, err: unknown, fallbackStatus = 500): void {
		if (err instanceof ConsoleError) {
			res.writeHead(err.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: err.message }));
			return;
		}
		const message = err instanceof Error ? err.message : String(err);
		res.writeHead(fallbackStatus, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: message || "Request failed" }));
	}

	private handlePreviewProxy(req: IncomingMessage, res: ServerResponse): boolean {
		const target = parsePreviewProxyTarget(req.url || "/");
		if (!target) return false;

		const upstream = httpRequest({
			hostname: "127.0.0.1",
			port: target.port,
			path: target.path,
			method: req.method,
			headers: previewProxyHeaders(req, target.port),
		}, (upstreamRes) => {
			res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		});

		upstream.on("error", (err) => {
			const message = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) {
				res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
			}
			res.end(`Preview server is not reachable on 127.0.0.1:${target.port}: ${message}`);
		});

		req.pipe(upstream);
		return true;
	}

	private handlePreviewUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
		const target = parsePreviewProxyTarget(req.url || "/");
		if (!target) return false;

		const upstream = connectSocket(target.port, "127.0.0.1");
		upstream.on("connect", () => {
			const headers = previewProxyHeaders(req, target.port);
			headers.connection = "Upgrade";
			if (req.headers.upgrade) headers.upgrade = req.headers.upgrade;
			if (req.headers["sec-websocket-key"]) headers["sec-websocket-key"] = req.headers["sec-websocket-key"];
			if (req.headers["sec-websocket-version"]) headers["sec-websocket-version"] = req.headers["sec-websocket-version"];
			if (req.headers["sec-websocket-protocol"]) headers["sec-websocket-protocol"] = req.headers["sec-websocket-protocol"];
			if (req.headers["sec-websocket-extensions"]) headers["sec-websocket-extensions"] = req.headers["sec-websocket-extensions"];

			upstream.write(`${req.method || "GET"} ${target.path} HTTP/${req.httpVersion}\r\n`);
			for (const [key, value] of Object.entries(headers)) {
				const values = Array.isArray(value) ? value : [value];
				for (const item of values) upstream.write(`${key}: ${item}\r\n`);
			}
			upstream.write("\r\n");
			if (head.length > 0) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		return true;
	}

	/** Handle GET /api/config — workspace configuration for the web UI */
	private handleConfigApi(_req: IncomingMessage, res: ServerResponse): void {
		const service = this.requireConsoleService(res);
		if (!service) return;
		try {
			const config = service.getConfig();
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(config));
			return;
		} catch (err) {
			this.sendConsoleError(res, err, 503);
		}
	}

	private handleConsoleSession(_req: IncomingMessage, res: ServerResponse): void {
		const service = this.requireConsoleService(res);
		if (!service) return;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(service.getSession()));
	}

	private handleConsoleAgents(_req: IncomingMessage, res: ServerResponse): void {
		const service = this.requireConsoleService(res);
		if (!service) return;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(service.getAgents()));
	}

	private handleConsoleStatus(_req: IncomingMessage, res: ServerResponse): void {
		const service = this.requireConsoleService(res);
		if (!service) return;
		try {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(service.getStatus()));
		} catch (err) {
			this.sendConsoleError(res, err, 503);
		}
	}

	private isConsoleAgentPath(urlPath: string, suffix: string): boolean {
		return new RegExp(`^/api/v2/agents/[^/]+${suffix}$`).test(urlPath);
	}

	/** Handle GET /api/files — directory listing */
	private handleFilesApi(req: IncomingMessage, res: ServerResponse): void {
		const service = this.requireConsoleService(res);
		if (!service) return;
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const requestedPath = url.searchParams.get("path") || "";

		try {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(service.listFiles(requestedPath)));
		} catch (err) {
			this.sendConsoleError(res, err, 404);
		}
	}

	/** Handle GET /api/file — read file contents */
	private handleFileApi(req: IncomingMessage, res: ServerResponse): void {
		const service = this.requireConsoleService(res);
		if (!service) return;
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const requestedPath = url.searchParams.get("path") || "";

		try {
			const content = service.readFile(requestedPath);
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(content);
		} catch (err) {
			this.sendConsoleError(res, err, 404);
		}
	}

	/** Handle POST /api/file/save — write file contents */
	private handleFileSaveApi(req: IncomingMessage, res: ServerResponse): void {
		const service = this.requireConsoleService(res);
		if (!service) return;
		const chunks: Buffer[] = [];
		let totalSize = 0;
		const MAX_SIZE = 5 * 1024 * 1024;

		req.on("data", (chunk: Buffer) => {
			totalSize += chunk.length;
			if (totalSize > MAX_SIZE) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "File too large (>5MB)" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (totalSize > MAX_SIZE) return;

			let payload: { path?: string; content?: string };
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid JSON" }));
				return;
			}

			try {
				service.writeFile(payload.path || "", payload.content as string);
				log.logInfo(`[save] wrote ${payload.path} (${payload.content?.length ?? 0} bytes)`);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (err) {
				log.logWarning("[save] write error", err instanceof Error ? err.message : String(err));
				this.sendConsoleError(res, err);
			}
		});
	}

	/** Handle POST /api/upload — multipart file upload to workspace */
	private handleUploadApi(req: IncomingMessage, res: ServerResponse): void {
		const service = this.requireConsoleService(res);
		if (!service) return;

		const contentType = req.headers["content-type"] || "";
		const boundaryMatch = contentType.match(/boundary=(.+)/);
		if (!boundaryMatch) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing multipart boundary" }));
			return;
		}

		const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB total
		const chunks: Buffer[] = [];
		let totalSize = 0;

		req.on("data", (chunk: Buffer) => {
			totalSize += chunk.length;
			if (totalSize > MAX_UPLOAD) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Upload too large (50MB max)" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (totalSize > MAX_UPLOAD) return; // already responded

			const body = Buffer.concat(chunks);
			const boundary = boundaryMatch![1];
			const uploaded: string[] = [];

			try {
				const files = parseMultipart(body, boundary);

				// Extract target directory from form fields
				let targetDir = "attachments";
				for (const file of files) {
					if (file.name === "targetDir" && !file.filename) {
						targetDir = file.data.toString("utf-8").trim() || "attachments";
						continue;
					}
					if (!file.filename) continue;

					const relPath = service.uploadFile(targetDir, file.filename, file.data);
					uploaded.push(relPath);
					log.logInfo(`[upload] wrote ${relPath} (${file.data.length} bytes)`);
				}

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ uploaded }));
			} catch (err) {
				log.logWarning("[upload] parse error", err instanceof Error ? err.message : String(err));
				this.sendConsoleError(res, err, 400);
			}
		});
	}

	/** Handle GET /awareness/backlog — returns last N lines of context.jsonl as JSON array.
	 *
	 * Tail-first reverse byte read (FAT-352): seeks from the end of the file
	 * backwards in CHUNK-sized blocks until enough newlines are found. Avoids
	 * reading the entire file (which through s3fs/gocryptfs FUSE was triggering
	 * full-file R2 GETs per request — root cause of the ~5 TB/mo egress storm
	 * documented in FAT-348/350/351/349).
	 *
	 * Pagination:
	 *   - before=0 (default): return the last `limit` lines
	 *   - before>0: return up to `limit` lines ending at line index `before`
	 *
	 * `total` is approximate — we return the line count consumed by this query
	 * and use file size as a sentinel for whether more history exists.
	 */
	private handleAwarenessBacklog(req: IncomingMessage, res: ServerResponse): void {
		if (!this.awarenessStore) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "No workspace configured" }));
			return;
		}

		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
		const before = parseInt(url.searchParams.get("before") || "0", 10) || 0;

		try {
			const backlog = this.awarenessStore.readBacklog(limit, before);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(backlog));
		} catch {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ lines: [], total: 0, offset: 0 }));
		}
	}

	/** Handle GET /awareness/stream — SSE endpoint that tails context.jsonl */
	private handleAwarenessStream(_req: IncomingMessage, res: ServerResponse): void {
		if (!this.workspaceDir) {
			res.writeHead(500);
			res.end("No workspace configured");
			return;
		}

		const contextFile = resolve(this.workspaceDir, "awareness/context.jsonl");

		// SSE headers
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});

		// Skip backlog — client fetches recent entries via /awareness/backlog instead.
		// Just record the current file size so the watcher only sends new lines.
		let currentSize = 0;
		try {
			const stat = statSync(contextFile);
			currentSize = stat.size;
		} catch {
			// File doesn't exist yet
		}

		// Register client
		this.awarenessClients.add(res);

		// Start the shared file watcher if not already running
		if (!this.awarenessWatcher) {
			this.awarenessFileSize = currentSize;
			this.startAwarenessWatcher(contextFile);
		}

		// Heartbeat to keep connection alive
		const heartbeat = setInterval(() => {
			try { res.write(": heartbeat\n\n"); } catch { /* client gone */ }
		}, 15000);

		// Clean up on disconnect
		res.on("close", () => {
			clearInterval(heartbeat);
			this.awarenessClients.delete(res);
			if (this.awarenessClients.size === 0 && this.awarenessWatcher) {
				clearInterval(this.awarenessWatcher);
				this.awarenessWatcher = null;
			}
		});
	}

	/** Poll context.jsonl for new bytes and push to all connected SSE clients */
	private startAwarenessWatcher(contextFile: string): void {
		this.awarenessWatcher = setInterval(() => {
			try {
				const stat = statSync(contextFile);
				const newSize = stat.size;
				if (newSize <= this.awarenessFileSize) return;

				// Read only the new bytes
				const fd = openSync(contextFile, "r");
				const buf = Buffer.alloc(newSize - this.awarenessFileSize);
				readSync(fd, buf, 0, buf.length, this.awarenessFileSize);
				closeSync(fd);

				this.awarenessFileSize = newSize;

				const newContent = buf.toString("utf-8");
				const lines = newContent.split("\n").filter(Boolean);

				for (const line of lines) {
					const id = extractAwarenessEventId(line);
					const event = `${id ? `id: ${id}\n` : ""}data: ${line}\n\n`;
					for (const client of this.awarenessClients) {
						try { client.write(event); } catch { /* client gone, will be cleaned up */ }
					}
				}
			} catch {
				// File gone or read error — skip this tick
			}
		}, 500);
	}

	/** Start listening on the given port */
	async start(port: number): Promise<void> {
		this.server = createServer((req, res) => {
			const rawUrl = req.url || "/";
			const urlPath = rawUrl.split("?")[0];

			// Health check — no auth
			if (req.method === "GET" && urlPath === "/health") {
				res.writeHead(200);
				res.end("ok");
				return;
			}

			// Registered GET routes (status, schedule) — no auth
			if (req.method === "GET") {
				const getHandler = this.getRoutes.get(rawUrl) || this.getRoutes.get(urlPath);
				if (getHandler) {
					getHandler(req, res);
					return;
				}
			}

			// Config API
			if (req.method === "GET" && urlPath === "/api/config") {
				this.handleConfigApi(req, res);
				return;
			}

			// Portable console API (standalone Troublemaker implementation).
			// Hosted Crawdad implements the same contract at the Worker layer.
			if (req.method === "GET" && urlPath === "/api/v2/session") {
				this.handleConsoleSession(req, res);
				return;
			}

			if (req.method === "GET" && urlPath === "/api/v2/agents") {
				this.handleConsoleAgents(req, res);
				return;
			}

			if (req.method === "GET" && this.isConsoleAgentPath(urlPath, "/status")) {
				this.handleConsoleStatus(req, res);
				return;
			}

			if (req.method === "GET" && this.isConsoleAgentPath(urlPath, "/events")) {
				this.handleAwarenessBacklog(req, res);
				return;
			}

			if (req.method === "GET" && this.isConsoleAgentPath(urlPath, "/events/stream")) {
				this.handleAwarenessStream(req, res);
				return;
			}

			if (req.method === "GET" && this.isConsoleAgentPath(urlPath, "/files")) {
				this.handleFilesApi(req, res);
				return;
			}

			if (req.method === "GET" && this.isConsoleAgentPath(urlPath, "/file")) {
				this.handleFileApi(req, res);
				return;
			}

			// File API routes
			if (req.method === "GET" && urlPath === "/api/files") {
				this.handleFilesApi(req, res);
				return;
			}

			if (req.method === "GET" && urlPath === "/api/file") {
				this.handleFileApi(req, res);
				return;
			}

			// Awareness backlog — paginated recent entries
			if (req.method === "GET" && urlPath === "/awareness/backlog") {
				this.handleAwarenessBacklog(req, res);
				return;
			}

			// Awareness stream — SSE endpoint (live updates only, no backlog)
			if (req.method === "GET" && urlPath === "/awareness/stream") {
				this.handleAwarenessStream(req, res);
				return;
			}

			if (this.handlePreviewProxy(req, res)) {
				return;
			}

			// Static UI serving
			if (req.method === "GET" && this.uiDir) {

				// Serve assets directly
				if (urlPath.startsWith("/assets/")) {
					const filePath = join(this.uiDir, urlPath);
					const normalized = normalize(filePath);
					if (normalized.startsWith(this.uiDir)) {
						this.serveStatic(normalized, res);
						return;
					}
				}

				// SPA fallback: any non-API, non-webhook GET → index.html
				const indexPath = join(this.uiDir, "index.html");
				if (existsSync(indexPath)) {
					this.serveStatic(indexPath, res);
					return;
				}
			}

			// File save API
			if (req.method === "POST" && urlPath === "/api/file/save") {
				this.handleFileSaveApi(req, res);
				return;
			}

			if (req.method === "PUT" && this.isConsoleAgentPath(urlPath, "/file")) {
				this.handleFileSaveApi(req, res);
				return;
			}

			// File upload API
			if (req.method === "POST" && urlPath === "/api/upload") {
				this.handleUploadApi(req, res);
				return;
			}

			if (req.method === "POST" && this.isConsoleAgentPath(urlPath, "/upload")) {
				this.handleUploadApi(req, res);
				return;
			}

			if (req.method === "POST" && this.isConsoleAgentPath(urlPath, "/messages")) {
				const handler = this.routes.get("/web/chat");
				if (!handler) {
					res.writeHead(404);
					res.end("Web chat route not registered");
					return;
				}
				if (!this.readyRoutes.has("/web/chat")) {
					res.writeHead(503);
					res.end("Adapter not ready");
					return;
				}
				handler(req, res);
				return;
			}

			if (req.method === "POST" && this.isConsoleAgentPath(urlPath, "/messages/stop")) {
				const handler = this.routes.get("/web/stop");
				if (!handler) {
					res.writeHead(404);
					res.end("Web stop route not registered");
					return;
				}
				if (!this.readyRoutes.has("/web/stop")) {
					res.writeHead(503);
					res.end("Adapter not ready");
					return;
				}
				handler(req, res);
				return;
			}

			// POST routes — webhook adapters (adapter-specific auth, no web token check)
			if (req.method === "POST") {
				const handler = this.routes.get(urlPath);
				if (!handler) {
					res.writeHead(404);
					res.end("Not found");
					return;
				}

				if (!this.readyRoutes.has(urlPath)) {
					log.logInfo(`[gateway] POST ${urlPath} → 503 (not ready)`);
					res.writeHead(503);
					res.end("Adapter not ready");
					return;
				}

				log.logInfo(`[gateway] POST ${urlPath} received at ${new Date().toISOString()}`);
				handler(req, res);
				return;
			}

			// Nothing matched
			if (req.method === "GET") {
				res.writeHead(404);
				res.end("Not found");
			} else {
				res.writeHead(405);
				res.end("Method not allowed");
			}
		});

		// Handle WebSocket upgrades
		this.server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
			const urlPath = (req.url || "").split("?")[0];
			if (this.handlePreviewUpgrade(req, socket, head)) {
				return;
			}
			const handler = this.upgradeRoutes.get(urlPath);
			if (handler) {
				handler(req, socket, head);
			} else {
				socket.destroy();
			}
		});

		await new Promise<void>((resolve) => {
			this.server!.listen(port, () => {
				log.logInfo(`[gateway] listening on port ${port} (${this.routes.size} POST + ${this.getRoutes.size} GET + ${this.upgradeRoutes.size} UPGRADE routes${this.uiDir ? " + UI" : ""})`);
				resolve();
			});
		});
	}

	/** Stop the server */
	async stop(): Promise<void> {
		if (this.server) {
			await new Promise<void>((resolve, reject) => {
				this.server!.close((err) => (err ? reject(err) : resolve()));
			});
			this.server = null;
		}
	}
}

// =============================================================================
// Multipart form-data parser (no dependencies)
// =============================================================================

interface MultipartFile {
	name: string;
	filename?: string;
	contentType?: string;
	data: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartFile[] {
	const files: MultipartFile[] = [];
	const delimBuf = Buffer.from(`--${boundary}`);
	const endBuf = Buffer.from(`--${boundary}--`);
	const crlfcrlf = Buffer.from("\r\n\r\n");

	let pos = 0;
	while (pos < body.length) {
		const partStart = bufferIndexOf(body, delimBuf, pos);
		if (partStart === -1) break;

		const afterDelim = partStart + delimBuf.length;
		// Check for final boundary
		if (body.slice(afterDelim, afterDelim + 2).toString() === "--") break;

		const headerStart = afterDelim + 2; // skip \r\n after boundary
		const headerEnd = bufferIndexOf(body, crlfcrlf, headerStart);
		if (headerEnd === -1) break;

		const headers = body.slice(headerStart, headerEnd).toString("utf-8");
		const dataStart = headerEnd + 4; // skip \r\n\r\n

		// Find next boundary to determine data end
		const nextBoundary = bufferIndexOf(body, delimBuf, dataStart);
		const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2; // -2 for \r\n before boundary

		const data = body.slice(dataStart, dataEnd);

		// Parse headers
		const nameMatch = headers.match(/name="([^"]+)"/);
		const filenameMatch = headers.match(/filename="([^"]+)"/);
		const ctMatch = headers.match(/Content-Type:\s*(.+)/i);

		if (nameMatch) {
			files.push({
				name: nameMatch[1],
				filename: filenameMatch?.[1],
				contentType: ctMatch?.[1]?.trim(),
				data,
			});
		}

		pos = nextBoundary === -1 ? body.length : nextBoundary;
	}

	return files;
}

function bufferIndexOf(buf: Buffer, search: Buffer, fromIndex: number): number {
	for (let i = fromIndex; i <= buf.length - search.length; i++) {
		let found = true;
		for (let j = 0; j < search.length; j++) {
			if (buf[i + j] !== search[j]) {
				found = false;
				break;
			}
		}
		if (found) return i;
	}
	return -1;
}

function extractAwarenessEventId(line: string): string | null {
	try {
		const parsed = JSON.parse(line) as { id?: unknown; timestamp?: unknown };
		const raw = parsed.id ?? parsed.timestamp;
		if (typeof raw !== "string" || raw.length === 0) return null;
		return raw.replace(/[\r\n]/g, "").slice(0, 128);
	} catch {
		return null;
	}
}
