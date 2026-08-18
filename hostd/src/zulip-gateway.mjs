import { bearerMatches } from "./security.mjs";

function json(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	response.end(JSON.stringify(value));
}

async function readRawBody(request, maximum = 25 * 1024 * 1024) {
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximum) throw new Error("Zulip proxy request exceeds limit");
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function positiveId(value) {
	const candidate = Number(value);
	return Number.isInteger(candidate) && candidate > 0 ? candidate : null;
}

function contextParts(contextId) {
	const [targetId, principalHash] = contextId.split(":");
	if (!targetId || !principalHash) throw new Error("Zulip binding has an invalid context ID");
	return { targetId, principalHash };
}

export function isExpiredZulipEventQueueError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /bad event queue id|bad_event_queue_id|event queue.*(?:expired|invalid|not found)/i.test(message);
}

export class ZulipGateway {
	constructor({ config, store, provisioner, scheduler, webChatGateway }) {
		this.config = config;
		this.store = store;
		this.provisioner = provisioner;
		this.scheduler = scheduler;
		this.webChatGateway = webChatGateway;
		this.stopped = true;
		this.pollPromise = null;
		this.queueId = null;
		this.lastEventId = -1;
		this.ignoredUserIds = new Set();
	}

	async registerQueue() {
		const registered = await this.provisioner.request("register", {
			method: "POST",
			form: new URLSearchParams({
				event_types: JSON.stringify(["message"]),
				client_capabilities: JSON.stringify({
					notification_settings_null: true,
					stream_typing_notifications: true,
				}),
			}),
		});
		if (typeof registered.queue_id !== "string" || !registered.queue_id.trim()) {
			throw new Error("Zulip event queue registration returned an invalid queue ID");
		}
		this.queueId = registered.queue_id.trim();
		this.lastEventId = Number.isInteger(registered.last_event_id)
			? registered.last_event_id
			: -1;
	}

	async recoverExpiredQueue(error) {
		if (!isExpiredZulipEventQueueError(error)) return false;
		await this.registerQueue();
		console.warn("troublemaker-hostd: re-registered expired Zulip event queue");
		return true;
	}

	async start() {
		if (!this.config.zulip) return;
		const identities = await this.provisioner.identities();
		this.ignoredUserIds = new Set([
			identities.agent.user_id,
			identities.projector.user_id,
			...identities.observers.map((user) => user.user_id),
		]);
		await this.registerQueue();
		this.stopped = false;
		console.log("troublemaker-hostd: host Zulip ingress connected");
		this.pollPromise = this.pollLoop();
	}

	async stop() {
		this.stopped = true;
		await this.pollPromise;
		this.pollPromise = null;
	}

	async pollLoop() {
		while (!this.stopped) {
			try {
				const result = await this.provisioner.request("events", {
					query: {
						queue_id: this.queueId,
						last_event_id: this.lastEventId,
						dont_block: true,
					},
				});
				for (const event of result.events ?? []) {
					if (Number.isInteger(event.id)) this.lastEventId = Math.max(this.lastEventId, event.id);
					if (event.type === "message") {
						await this.ingestMessage(event.message);
					}
				}
			} catch (error) {
				if (!this.stopped) {
					let recovered = false;
					try {
						recovered = await this.recoverExpiredQueue(error);
					} catch (recoveryError) {
						console.error(
							"troublemaker-hostd: Zulip event queue recovery failed:",
							recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
						);
					}
					if (!recovered) {
						console.error(
							"troublemaker-hostd: Zulip ingress poll failed:",
							error instanceof Error ? error.message : String(error),
						);
					}
				}
			}
			if (!this.stopped) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
			}
		}
	}

	async ingestMessage(message) {
		const messageId = positiveId(message?.id);
		const channelId = positiveId(message?.stream_id);
		const senderId = positiveId(message?.sender_id);
		if (!messageId || !channelId || !senderId || message?.type !== "stream") return;
		if (this.ignoredUserIds.has(senderId)) return;
		const binding = this.store.getZulipBindingByChannel(channelId);
		if (!binding) return;
		if (this.store.getEventByProviderMessage("zulip", String(messageId))) return;
		if (binding.attentionMode === "mentions-only" && message.is_mentioned !== true) return;

		const detail = await this.provisioner.request(`messages/${messageId}`);
		const rawContent = typeof detail?.message?.raw_content === "string"
			? detail.message.raw_content
			: undefined;
		const { targetId, principalHash } = contextParts(binding.contextId);
		const event = this.store.upsertEvent({
			id: `zulip:${messageId}`,
			source: "zulip",
			providerMessageId: String(messageId),
			providerThreadId: `channel:${channelId}`,
			principalHash,
			targetId,
			contextId: binding.contextId,
			payload: {
				message: {
					...message,
					...(rawContent === undefined ? {} : { raw_content: rawContent }),
				},
			},
		});
		this.scheduler?.pump();
		console.log(
			`troublemaker-hostd: queued Zulip message ${messageId} as awareness sequence ${event.awarenessSequence} for ${binding.contextId}`,
		);
	}

	async validateMessage(binding, messageIdentifier, { requireAgent = false } = {}) {
		const id = positiveId(messageIdentifier);
		if (!id) throw new Error("Zulip message ID is invalid");
		const result = await this.provisioner.request(`messages/${id}`, {
			auth: "agent",
		});
		if (Number(result.message?.stream_id) !== Number(binding.channelId)) {
			throw new Error("Zulip message is outside the bound customer channel");
		}
		if (requireAgent && Number(result.message?.sender_id) !== Number(binding.agentUserId)) {
			throw new Error("Zulip agent may only mutate its own messages");
		}
		return result.message;
	}

	async proxy(request, response, contextId, providerPath, expectedToken) {
		if (!bearerMatches(request.headers.authorization, expectedToken)) {
			json(response, 401, { result: "error", msg: "unauthorized" });
			return;
		}
		const binding = (
			await this.provisioner.runtimeBinding(contextId)
			?? await this.provisioner.ensureContext(contextId)
		);
		if (!binding) {
			json(response, 404, { result: "error", msg: "zulip_context_not_provisioned" });
			return;
		}
		const parsed = new URL(providerPath, "http://hostd.invalid");
		const path = parsed.pathname;

		if (request.method === "GET" && path === "/users/me") {
			json(response, 200, await this.provisioner.request("users/me", { auth: "agent" }));
			return;
		}
		if (request.method === "GET" && path === "/streams") {
			const result = await this.provisioner.request("streams", {
				auth: "agent",
				query: {
					include_public: true,
					include_subscribed: true,
					include_all_active: true,
				},
			});
			json(response, 200, {
				...result,
				streams: (result.streams ?? []).filter(
					(stream) => Number(stream.stream_id) === Number(binding.channelId),
				),
			});
			return;
		}
		const messageMatch = path.match(/^\/messages\/([1-9]\d*)$/);
		if (request.method === "GET" && messageMatch) {
			await this.validateMessage(binding, messageMatch[1]);
			json(response, 200, await this.provisioner.request(`messages/${messageMatch[1]}`, {
				auth: "agent",
			}));
			return;
		}
		if (request.method === "POST" && path === "/messages") {
			const input = new URLSearchParams((await readRawBody(request, 2 * 1024 * 1024)).toString("utf8"));
			if (
				input.get("type") !== "channel"
				|| Number(input.get("to")) !== Number(binding.channelId)
				|| (input.get("topic") ?? "") !== ""
			) {
				json(response, 403, { result: "error", msg: "zulip_channel_scope_denied" });
				return;
			}
			const content = input.get("content")?.trim() || "";
			if (!content) {
				json(response, 400, { result: "error", msg: "content_required" });
				return;
			}
			const created = await this.provisioner.request("messages", {
				method: "POST",
				auth: "agent",
				form: new URLSearchParams({
					type: "channel",
					to: String(binding.channelId),
					topic: "",
					content,
				}),
			});
			try {
				this.webChatGateway?.queueOperatorMessage(contextId, created.id, content);
			} catch (error) {
				console.error(
					`troublemaker-hostd: website chat reply ${String(created.id || "unknown")} could not be queued:`,
					error instanceof Error ? error.message : String(error),
				);
			}
			json(response, 200, created);
			return;
		}
		if (messageMatch && request.method === "PATCH") {
			await this.validateMessage(binding, messageMatch[1], { requireAgent: true });
			const input = new URLSearchParams((await readRawBody(request, 2 * 1024 * 1024)).toString("utf8"));
			const content = input.get("content")?.trim() || "";
			if (!content) {
				json(response, 400, { result: "error", msg: "content_required" });
				return;
			}
			json(response, 200, await this.provisioner.request(`messages/${messageMatch[1]}`, {
				method: "PATCH",
				auth: "agent",
				form: new URLSearchParams({ content }),
			}));
			return;
		}
		if (messageMatch && request.method === "DELETE") {
			await this.validateMessage(binding, messageMatch[1], { requireAgent: true });
			json(response, 200, await this.provisioner.request(`messages/${messageMatch[1]}`, {
				method: "DELETE",
				auth: "agent",
			}));
			return;
		}
		if (request.method === "POST" && path === "/typing") {
			const input = new URLSearchParams((await readRawBody(request, 64 * 1024)).toString("utf8"));
			if (
				input.get("type") !== "channel"
				|| Number(input.get("stream_id")) !== Number(binding.channelId)
				|| (input.get("topic") ?? "") !== ""
			) {
				json(response, 403, { result: "error", msg: "zulip_channel_scope_denied" });
				return;
			}
			json(response, 200, await this.provisioner.request("typing", {
				method: "POST",
				auth: "agent",
				form: new URLSearchParams({
					type: "channel",
					stream_id: String(binding.channelId),
					topic: "",
					op: input.get("op") === "stop" ? "stop" : "start",
				}),
			}));
			return;
		}
		if (request.method === "POST" && path === "/user_uploads") {
			if (!String(request.headers["content-type"] || "").startsWith("multipart/form-data;")) {
				json(response, 400, { result: "error", msg: "multipart_required" });
				return;
			}
			const credentials = this.provisioner.auth("agent");
			const upstream = await fetch(`${this.config.zulip.url}/api/v1/user_uploads`, {
				method: "POST",
				headers: {
					authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.apiKey}`).toString("base64")}`,
					"content-type": request.headers["content-type"],
				},
				body: await readRawBody(request),
				signal: AbortSignal.timeout(30_000),
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
}
