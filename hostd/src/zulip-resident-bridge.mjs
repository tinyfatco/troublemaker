import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_PROXY_BODY_BYTES = 25 * 1024 * 1024;
const DELIVERY_TIMEOUT_MS = 35 * 60_000;

function positiveId(value, label) {
	const candidate = Number(value);
	if (!Number.isInteger(candidate) || candidate <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return candidate;
}

function requiredText(value, label) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	return value.trim();
}

function httpUrl(value, label) {
	const parsed = new URL(requiredText(value, label));
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
		throw new Error(`${label} must be an HTTP(S) URL without embedded credentials`);
	}
	return parsed.toString().replace(/\/$/, "");
}

function safeEqual(actual, expected) {
	const left = Buffer.from(actual || "");
	const right = Buffer.from(expected || "");
	return left.length === right.length && timingSafeEqual(left, right);
}

function bearerMatches(header, expected) {
	return safeEqual(header?.replace(/^Bearer\s+/i, "") || "", expected);
}

function basicAuthorization(email, apiKey) {
	return `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;
}

function json(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	response.end(JSON.stringify(value));
}

async function readRawBody(request, maximum = MAX_PROXY_BODY_BYTES) {
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximum) throw new Error("request body exceeds the bridge limit");
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function isExpiredQueueError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /bad event queue id|bad_event_queue_id|event queue.*(?:expired|invalid|not found)|zulip get events returned http 400/i.test(message);
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ZulipResidentBridge {
	constructor(config) {
		this.zulipUrl = httpUrl(config.zulipUrl, "zulipUrl");
		this.zulipEmail = requiredText(config.zulipEmail, "zulipEmail").toLowerCase();
		this.zulipApiKey = requiredText(config.zulipApiKey, "zulipApiKey");
		this.channelId = positiveId(config.channelId, "channelId");
		this.proxyToken = requiredText(config.proxyToken, "proxyToken");
		this.inboundUrl = httpUrl(config.inboundUrl, "inboundUrl");
		this.inboundToken = requiredText(config.inboundToken, "inboundToken");
		this.receiptToken = requiredText(config.receiptToken, "receiptToken");
		this.statePath = requiredText(config.statePath, "statePath");
		this.listenHost = config.listenHost || "127.0.0.1";
		this.listenPort = Number.isInteger(Number(config.listenPort)) ? Number(config.listenPort) : 0;
		if (this.listenPort < 0 || this.listenPort > 65_535) throw new Error("listenPort is invalid");
		this.server = null;
		this.botUserId = null;
		this.queueId = null;
		this.lastEventId = -1;
		this.lastMessageId = null;
		this.pollPromise = null;
		this.stopped = true;
		this.pendingReceipts = new Map();
	}

	async start() {
		if (this.server) throw new Error("Zulip resident bridge is already started");
		const me = await this.nativeRequest("users/me");
		this.botUserId = positiveId(me.user_id, "Zulip bot user ID");
		if (me.is_bot !== true) throw new Error("Zulip resident bridge identity must be a bot");
		const streams = await this.nativeRequest("streams", {
			query: {
				include_public: "true",
				include_subscribed: "true",
				include_all_active: "true",
			},
		});
		const channel = (streams.streams || []).find((candidate) => Number(candidate.stream_id) === this.channelId);
		if (!channel) throw new Error(`Zulip bot is not subscribed to channel ${this.channelId}`);
		if (channel.topics_policy !== "empty_topic_only") {
			throw new Error(`Zulip channel ${this.channelId} must use the topic-free policy`);
		}

		await this.listen();
		try {
			await this.registerQueue();
			this.lastMessageId = this.loadLastMessageId();
			if (this.lastMessageId === null) {
				this.lastMessageId = await this.newestChannelMessageId();
				this.saveLastMessageId(this.lastMessageId);
			} else {
				await this.catchUp();
			}
			this.stopped = false;
			this.pollPromise = this.pollLoop();
		} catch (error) {
			await this.closeServer();
			throw error;
		}
	}

	async stop() {
		this.stopped = true;
		await this.pollPromise;
		this.pollPromise = null;
		for (const pending of this.pendingReceipts.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Zulip resident bridge stopped"));
		}
		this.pendingReceipts.clear();
		await this.closeServer();
	}

	proxyUrl() {
		const address = this.server?.address();
		if (!address || typeof address === "string") throw new Error("Zulip resident bridge is not listening");
		const host = this.listenHost.includes(":") ? `[${this.listenHost}]` : this.listenHost;
		return `http://${host}:${address.port}`;
	}

	async listen() {
		this.server = createServer((request, response) => {
			void this.handleHttp(request, response).catch((error) => {
				json(response, 500, {
					result: "error",
					msg: error instanceof Error ? error.message : String(error),
				});
			});
		});
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.listenPort, this.listenHost, () => {
				this.server.off("error", reject);
				resolve();
			});
		});
	}

	async closeServer() {
		const server = this.server;
		this.server = null;
		if (!server) return;
		await new Promise((resolve) => server.close(() => resolve()));
	}

	async handleHttp(request, response) {
		const url = new URL(request.url || "/", "http://bridge.invalid");
		if (request.method === "POST" && url.pathname === "/receipt") {
			await this.handleReceipt(request, response);
			return;
		}
		if (!url.pathname.startsWith("/api/v1/")) {
			json(response, 404, { result: "error", msg: "not found" });
			return;
		}
		if (!bearerMatches(request.headers.authorization, this.proxyToken)) {
			json(response, 401, { result: "error", msg: "unauthorized" });
			return;
		}
		const providerPath = url.pathname.slice("/api/v1/".length);
		await this.proxy(request, response, providerPath);
	}

	async handleReceipt(request, response) {
		if (!bearerMatches(request.headers.authorization, this.receiptToken)) {
			json(response, 401, { ok: false, error: "unauthorized" });
			return;
		}
		let body;
		try {
			body = JSON.parse((await readRawBody(request, 64 * 1024)).toString("utf8"));
		} catch {
			json(response, 400, { ok: false, error: "invalid_json" });
			return;
		}
		const pending = this.pendingReceipts.get(body.lease_token);
		if (!pending) {
			json(response, 404, { ok: false, error: "unknown_lease" });
			return;
		}
		if (body.status === "completed") pending.resolve();
		else if (body.status === "failed") pending.reject(new Error(String(body.error || "resident delivery failed")));
		else if (body.status !== "running" && body.status !== "heartbeat") {
			json(response, 400, { ok: false, error: "invalid_status" });
			return;
		}
		json(response, 200, { ok: true });
	}

	async proxy(request, response, providerPath) {
		if (request.method === "GET" && providerPath === "users/me") {
			json(response, 200, await this.nativeRequest("users/me"));
			return;
		}
		if (request.method === "GET" && providerPath === "streams") {
			const result = await this.nativeRequest("streams", {
				query: {
					include_public: "true",
					include_subscribed: "true",
					include_all_active: "true",
				},
			});
			json(response, 200, {
				...result,
				streams: (result.streams || []).filter((channel) => Number(channel.stream_id) === this.channelId),
			});
			return;
		}
		if (request.method === "POST" && providerPath === "messages") {
			const body = new URLSearchParams((await readRawBody(request, 2 * 1024 * 1024)).toString("utf8"));
			if (
				body.get("type") !== "channel"
				|| Number(body.get("to")) !== this.channelId
				|| (body.get("topic") || "") !== ""
			) {
				json(response, 403, { result: "error", msg: "zulip_channel_scope_denied" });
				return;
			}
			const content = body.get("content")?.trim() || "";
			if (!content) {
				json(response, 400, { result: "error", msg: "content_required" });
				return;
			}
			json(response, 200, await this.nativeRequest("messages", {
				method: "POST",
				body: new URLSearchParams({ type: "channel", to: String(this.channelId), topic: "", content }),
			}));
			return;
		}
		const messageMatch = providerPath.match(/^messages\/([1-9]\d*)$/);
		if (messageMatch && ["PATCH", "DELETE"].includes(request.method || "")) {
			const message = await this.validateOwnMessage(messageMatch[1]);
			if (request.method === "PATCH") {
				const body = new URLSearchParams((await readRawBody(request, 2 * 1024 * 1024)).toString("utf8"));
				const content = body.get("content")?.trim() || "";
				if (!content) {
					json(response, 400, { result: "error", msg: "content_required" });
					return;
				}
				json(response, 200, await this.nativeRequest(`messages/${message.id}`, {
					method: "PATCH",
					body: new URLSearchParams({ content }),
				}));
				return;
			}
			json(response, 200, await this.nativeRequest(`messages/${message.id}`, { method: "DELETE" }));
			return;
		}
		if (request.method === "POST" && providerPath === "user_uploads") {
			const contentType = request.headers["content-type"];
			if (typeof contentType !== "string" || !contentType.startsWith("multipart/form-data;")) {
				json(response, 400, { result: "error", msg: "multipart_required" });
				return;
			}
			const upstream = await this.nativeFetch("user_uploads", {
				method: "POST",
				headers: { "content-type": contentType },
				body: await readRawBody(request),
			});
			const payload = Buffer.from(await upstream.arrayBuffer());
			response.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") || "application/json",
				"cache-control": "no-store",
			});
			response.end(payload);
			return;
		}
		json(response, 404, { result: "error", msg: "zulip_proxy_route_not_found" });
	}

	async validateOwnMessage(messageId) {
		const result = await this.nativeRequest(`messages/${messageId}`);
		const message = result.message;
		if (Number(message?.stream_id) !== this.channelId) {
			throw new Error("Zulip message is outside the bridge channel");
		}
		if (Number(message?.sender_id) !== this.botUserId) {
			throw new Error("Zulip bridge may only mutate its bot's messages");
		}
		return message;
	}

	async registerQueue() {
		const result = await this.nativeRequest("register", {
			method: "POST",
			body: new URLSearchParams({
				event_types: JSON.stringify(["message"]),
				client_capabilities: JSON.stringify({
					notification_settings_null: true,
					stream_typing_notifications: true,
				}),
			}),
		});
		if (typeof result.queue_id !== "string" || !result.queue_id.trim()) {
			throw new Error("Zulip event queue registration returned an invalid queue ID");
		}
		this.queueId = result.queue_id.trim();
		this.lastEventId = Number.isInteger(result.last_event_id) ? result.last_event_id : -1;
	}

	async pollLoop() {
		while (!this.stopped) {
			try {
				const result = await this.nativeRequest("events", {
					query: {
						queue_id: this.queueId,
						last_event_id: String(this.lastEventId),
						dont_block: "true",
					},
				});
				for (const event of result.events || []) {
					if (event.type === "message") await this.ingestMessage(event.message);
					if (Number.isInteger(event.id)) this.lastEventId = Math.max(this.lastEventId, event.id);
				}
			} catch (error) {
				if (!this.stopped) {
					if (isExpiredQueueError(error)) {
						try {
							await this.registerQueue();
							await this.catchUp();
							console.warn("zulip-resident-bridge: re-registered expired event queue");
						} catch (recoveryError) {
							console.error(
								"zulip-resident-bridge: event queue recovery failed:",
								recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
							);
						}
					} else {
						console.error("zulip-resident-bridge: poll failed:", error instanceof Error ? error.message : String(error));
					}
				}
			}
			if (!this.stopped) await sleep(500);
		}
	}

	async ingestMessage(message) {
		const messageId = positiveId(message?.id, "Zulip message ID");
		const channelId = positiveId(message?.stream_id, "Zulip channel ID");
		const senderId = positiveId(message?.sender_id, "Zulip sender ID");
		if (message?.type !== "stream" || channelId !== this.channelId) return;
		if (senderId === this.botUserId) {
			this.advanceMessageCursor(messageId);
			return;
		}
		const detail = await this.nativeRequest(`messages/${messageId}`);
		const rawContent = typeof detail.message?.raw_content === "string"
			? detail.message.raw_content
			: undefined;
		await this.deliver({
			...message,
			...(rawContent === undefined ? {} : { raw_content: rawContent }),
		});
		this.advanceMessageCursor(messageId);
	}

	async deliver(message) {
		const leaseToken = randomUUID();
		let resolveReceipt;
		let rejectReceipt;
		const completed = new Promise((resolve, reject) => {
			resolveReceipt = resolve;
			rejectReceipt = reject;
		});
		const timer = setTimeout(() => {
			rejectReceipt(new Error(`Zulip resident delivery ${message.id} timed out`));
		}, DELIVERY_TIMEOUT_MS);
		timer.unref();
		this.pendingReceipts.set(leaseToken, {
			resolve: resolveReceipt,
			reject: rejectReceipt,
			timer,
		});
		try {
			const response = await fetch(this.inboundUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.inboundToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					deliveryId: `zulip:${message.id}`,
					message,
					hostReceipt: {
						url: `${this.proxyUrl()}/receipt`,
						token: this.receiptToken,
						leaseToken,
					},
				}),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new Error(`Zulip resident inbound returned HTTP ${response.status}`);
			await completed;
		} finally {
			clearTimeout(timer);
			this.pendingReceipts.delete(leaseToken);
		}
	}

	loadLastMessageId() {
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
			return positiveId(parsed.lastMessageId, "stored Zulip message ID");
		} catch (error) {
			if (error?.code === "ENOENT") return null;
			throw new Error("Zulip resident bridge state is unreadable");
		}
	}

	saveLastMessageId(lastMessageId) {
		if (lastMessageId === null) return;
		mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.statePath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, lastMessageId })}\n`, { mode: 0o600 });
		renameSync(temporary, this.statePath);
	}

	advanceMessageCursor(messageId) {
		this.lastMessageId = Math.max(this.lastMessageId || 0, messageId);
		this.saveLastMessageId(this.lastMessageId);
	}

	async newestChannelMessageId() {
		const result = await this.channelMessages({
			anchor: "newest",
			num_before: "1",
			num_after: "0",
			include_anchor: "true",
		});
		const ids = (result.messages || []).map((message) => Number(message.id)).filter(Number.isInteger);
		return ids.length > 0 ? Math.max(...ids) : null;
	}

	async catchUp() {
		if (this.lastMessageId === null) return;
		while (true) {
			const result = await this.channelMessages({
				anchor: String(this.lastMessageId),
				num_before: "0",
				num_after: "100",
				include_anchor: "false",
			});
			const messages = (result.messages || [])
				.filter((message) => Number(message.id) > this.lastMessageId)
				.sort((left, right) => Number(left.id) - Number(right.id));
			if (messages.length === 0) return;
			for (const message of messages) await this.ingestMessage(message);
			if (messages.length < 100) return;
		}
	}

	channelMessages(query) {
		return this.nativeRequest("messages", {
			query: {
				...query,
				narrow: JSON.stringify([{ operator: "channel", operand: this.channelId }]),
			},
		});
	}

	async nativeRequest(path, { method = "GET", query, body } = {}) {
		const response = await this.nativeFetch(path, { method, query, body });
		const text = await response.text();
		let payload;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			if (!response.ok) {
				throw new Error(`Zulip ${method} ${path} returned HTTP ${response.status}: invalid JSON response`);
			}
			throw new Error(`Zulip ${method} ${path} returned invalid JSON`);
		}
		if (!response.ok || payload?.result === "error") {
			const detail = typeof payload?.msg === "string" ? `: ${payload.msg.slice(0, 500)}` : "";
			throw new Error(`Zulip ${method} ${path} returned HTTP ${response.status}${detail}`);
		}
		return payload;
	}

	nativeFetch(path, { method = "GET", query, headers = {}, body } = {}) {
		const url = new URL(`${this.zulipUrl}/api/v1/${String(path).replace(/^\/+/, "")}`);
		for (const [key, value] of Object.entries(query || {})) {
			if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
		}
		return fetch(url, {
			method,
			headers: {
				...headers,
				authorization: basicAuthorization(this.zulipEmail, this.zulipApiKey),
			},
			body,
			signal: AbortSignal.timeout(30_000),
		});
	}
}
