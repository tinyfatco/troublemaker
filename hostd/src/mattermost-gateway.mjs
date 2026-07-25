import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { bearerMatches } from "./security.mjs";

function contextDirectory(target, contextId) {
	return resolve(target.contextsDirectory, contextId.replace(/[^a-z0-9_.-]/gi, "_"));
}

async function readBody(request, maximum = 25 * 1024 * 1024) {
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximum) throw new Error("Mattermost proxy request exceeds limit");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function json(response, status, value) {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

export class MattermostGateway {
	constructor({ config, store, provisioner, scheduler }) {
		this.config = config;
		this.store = store;
		this.provisioner = provisioner;
		this.scheduler = scheduler;
		this.websocket = null;
		this.stopped = false;
		this.reconnectTimer = null;
	}

	async start() {
		if (!this.config.mattermost) return;
		this.stopped = false;
		await this.connect();
	}

	async stop() {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		const websocket = this.websocket;
		this.websocket = null;
		if (websocket) websocket.close(1000, "hostd shutdown");
	}

	connect() {
		return new Promise((resolvePromise, reject) => {
			const parsed = new URL(this.config.mattermost.url);
			const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
			const websocket = new WebSocket(
				`${protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}/api/v4/websocket`,
			);
			this.websocket = websocket;
			let authenticated = false;
			const timeout = setTimeout(() => {
				websocket.terminate();
				reject(new Error("Mattermost gateway authentication timed out"));
			}, 10_000);
			websocket.on("open", () => {
				websocket.send(JSON.stringify({
					seq: 1,
					action: "authentication_challenge",
					data: { token: this.config.mattermost.adminToken },
				}));
			});
			websocket.on("message", (raw) => {
				let event;
				try {
					event = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (event.seq_reply === 1) {
					clearTimeout(timeout);
					if (event.status !== "OK") {
						reject(new Error(event.error?.message || "Mattermost gateway authentication failed"));
						websocket.close();
						return;
					}
					authenticated = true;
					console.log("troublemaker-hostd: host Mattermost ingress connected");
					resolvePromise();
					return;
				}
				if (event.event === "posted") void this.ingestPosted(event);
			});
			websocket.on("error", (error) => {
				if (!authenticated) {
					clearTimeout(timeout);
					reject(error);
				} else {
					console.error("troublemaker-hostd: Mattermost gateway error:", error.message);
				}
			});
			websocket.on("close", () => {
				clearTimeout(timeout);
				if (this.websocket === websocket) this.websocket = null;
				if (!this.stopped && authenticated) this.scheduleReconnect();
			});
		});
	}

	scheduleReconnect() {
		if (this.stopped || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect().catch((error) => {
				console.error("troublemaker-hostd: Mattermost reconnect failed:", error.message);
				this.scheduleReconnect();
			});
		}, 2_000);
	}

	async attentionMode(binding) {
		const context = this.store.getContext(binding.contextId);
		const target = context ? this.config.targetsById.get(context.targetId) : undefined;
		if (!target) return binding.attentionMode || "ambient";
		try {
			const settings = JSON.parse(await readFile(
				join(contextDirectory(target, binding.contextId), "workspace", "settings.json"),
				"utf8",
			));
			const mentionsOnly = settings?.mattermost?.mentionsOnlyChannelIds;
			const mode = Array.isArray(mentionsOnly) && mentionsOnly.includes(binding.channelId)
				? "mentions-only"
				: "ambient";
			if (mode !== binding.attentionMode) this.store.setMattermostAttention(binding.contextId, mode);
			return mode;
		} catch (error) {
			if (error?.code !== "ENOENT") {
				console.warn(`troublemaker-hostd: could not read Mattermost attention for ${binding.contextId}`);
			}
			return binding.attentionMode || "ambient";
		}
	}

	async ingestPosted(event) {
		let post;
		try {
			post = JSON.parse(event.data?.post || "");
		} catch {
			return;
		}
		if (!post?.id || !post.channel_id || !post.user_id || post.delete_at) return;
		if (typeof post.type === "string" && post.type.startsWith("system_")) return;
		if (this.provisioner.isControlBotUser(post.user_id)) return;
		const binding = this.store.getMattermostBindingByChannel(post.channel_id);
		if (!binding || post.user_id === binding.botUserId) return;
		const mode = await this.attentionMode(binding);
		const mentioned = new RegExp(`(^|\\s)@${binding.botUsername}\\b`, "i").test(post.message || "");
		if (mode === "mentions-only" && !mentioned) return;
		const route = this.store.getRouteForContext(binding.contextId);
		const context = this.store.getContext(binding.contextId);
		if (!route || !context) return;
		const queued = this.store.upsertEvent({
			id: randomUUID(),
			source: "mattermost",
			providerMessageId: post.id,
			providerThreadId: post.root_id || post.id,
			principalHash: route.principalHash,
			targetId: context.targetId,
			contextId: binding.contextId,
			payload: { post },
		});
		if (queued.status === "queued" || queued.status === "failed") {
			console.log(`troublemaker-hostd: queued Mattermost post ${post.id} for ${binding.contextId}`);
			this.scheduler.pump();
		}
	}

	async verifyPostChannel(binding, botToken, postId) {
		const response = await fetch(
			`${this.config.mattermost.url}/api/v4/posts/${encodeURIComponent(postId)}`,
			{
				headers: { authorization: `Bearer ${botToken}` },
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (!response.ok) return false;
		const post = await response.json();
		return post?.channel_id === binding.channelId;
	}

	async verifyChannelMember(binding, botToken, userId) {
		if (userId === binding.botUserId) return true;
		const response = await fetch(
			`${this.config.mattermost.url}/api/v4/channels/${binding.channelId}/members/${encodeURIComponent(userId)}`,
			{
				headers: { authorization: `Bearer ${botToken}` },
				signal: AbortSignal.timeout(15_000),
			},
		);
		return response.ok;
	}

	async proxy(request, response, contextId, apiPath, expectedToken) {
		if (!bearerMatches(request.headers.authorization, expectedToken)) {
			json(response, 401, { error: "unauthorized" });
			return;
		}
		const binding = await this.provisioner.runtimeBinding(contextId);
		if (!binding) {
			json(response, 404, { error: "mattermost_context_not_provisioned" });
			return;
		}
		const method = request.method || "GET";
		const allowed = (
			(method === "GET" && /^\/(?:users\/me|users\/[a-z0-9]{26}|users\/me\/teams|users\/me\/teams\/[a-z0-9]{26}\/channels|channels\/[a-z0-9]{26}|posts\/[a-z0-9]{26}(?:\/thread)?|files\/[a-z0-9]{26}(?:\/info)?)$/.test(apiPath))
			|| (method === "POST" && /^\/(?:posts|files)$/.test(apiPath))
			|| (method === "PUT" && /^\/posts\/[a-z0-9]{26}$/.test(apiPath))
			|| (method === "DELETE" && /^\/posts\/[a-z0-9]{26}$/.test(apiPath))
		);
		if (!allowed) {
			json(response, 403, { error: "mattermost_operation_denied" });
			return;
		}
		const channelMatch = apiPath.match(/^\/channels\/([a-z0-9]{26})$/);
		if (channelMatch && channelMatch[1] !== binding.channelId) {
			json(response, 403, { error: "mattermost_channel_scope_denied" });
			return;
		}
		const teamChannelsMatch = apiPath.match(/^\/users\/me\/teams\/([a-z0-9]{26})\/channels$/);
		if (teamChannelsMatch && teamChannelsMatch[1] !== binding.teamId) {
			json(response, 403, { error: "mattermost_team_scope_denied" });
			return;
		}
		const userMatch = apiPath.match(/^\/users\/([a-z0-9]{26})$/);
		if (
			userMatch
			&& !(await this.verifyChannelMember(binding, binding.botToken, userMatch[1]))
		) {
			json(response, 403, { error: "mattermost_user_scope_denied" });
			return;
		}
		const body = ["GET", "HEAD"].includes(method) ? undefined : await readBody(request);
		if (body?.length && String(request.headers["content-type"] || "").includes("application/json")) {
			const parsed = JSON.parse(body.toString("utf8"));
			if (parsed.channel_id && parsed.channel_id !== binding.channelId) {
				json(response, 403, { error: "mattermost_channel_scope_denied" });
				return;
			}
		}
		if (method === "POST" && apiPath === "/files") {
			const encoded = body?.toString("latin1") || "";
			if (!encoded.includes(`\r\n\r\n${binding.channelId}\r\n`)) {
				json(response, 403, { error: "mattermost_channel_scope_denied" });
				return;
			}
		}
		const postMatch = apiPath.match(/^\/posts\/([a-z0-9]{26})(?:\/thread)?$/);
		if (postMatch && !(await this.verifyPostChannel(binding, binding.botToken, postMatch[1]))) {
			json(response, 403, { error: "mattermost_post_scope_denied" });
			return;
		}
		const upstream = await fetch(`${this.config.mattermost.url}/api/v4${apiPath}${new URL(request.url, "http://localhost").search}`, {
			method,
			headers: {
				authorization: `Bearer ${binding.botToken}`,
				...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
			},
			body,
			signal: AbortSignal.timeout(30_000),
		});
		let payload = Buffer.from(await upstream.arrayBuffer());
		if (upstream.ok && method === "GET" && apiPath === "/users/me/teams") {
			const teams = JSON.parse(payload.toString("utf8"));
			payload = Buffer.from(JSON.stringify(
				Array.isArray(teams) ? teams.filter((team) => team?.id === binding.teamId) : [],
			));
		}
		if (upstream.ok && method === "GET" && /^\/users\/me\/teams\/[a-z0-9]{26}\/channels$/.test(apiPath)) {
			const channels = JSON.parse(payload.toString("utf8"));
			payload = Buffer.from(JSON.stringify(
				Array.isArray(channels)
					? channels.filter((channel) => channel?.id === binding.channelId)
					: [],
			));
		}
		response.writeHead(upstream.status, {
			"content-type": upstream.headers.get("content-type") || "application/octet-stream",
			"cache-control": "no-store",
		});
		response.end(payload);
	}
}
