import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_PROXY_BODY_BYTES = 25 * 1024 * 1024;
const DELIVERY_TIMEOUT_MS = 35 * 60_000;
const DELIVERY_ACCEPT_TIMEOUT_MS = 30_000;

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

function directRecipientIds(value, botUserId) {
	let parsed;
	try {
		parsed = JSON.parse(String(value || ""));
	} catch {
		throw new Error("Zulip direct recipients must be a JSON array of user IDs");
	}
	if (!Array.isArray(parsed)) throw new Error("Zulip direct recipients must be a JSON array of user IDs");
	const ids = Array.from(new Set(parsed.map((userId) => positiveId(userId, "Zulip direct recipient ID"))))
		.filter((userId) => userId !== botUserId)
		.sort((left, right) => left - right);
	if (ids.length === 0) throw new Error("Zulip direct message requires at least one other participant");
	return ids;
}

function directConversationKey(recipientIds) {
	return `dm:${recipientIds.join(",")}`;
}

function directConversationFromMessage(message, botUserId) {
	if (!Array.isArray(message?.display_recipient)) {
		throw new Error("Zulip direct message omitted its participant list");
	}
	return directConversationKey(directRecipientIds(
		JSON.stringify(message.display_recipient.map((recipient) => recipient?.id)),
		botUserId,
	));
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

function escapedRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function priorityStopText(message, botUserId, botFullName) {
	const rawContent = typeof message?.raw_content === "string" ? message.raw_content : "";
	let mentioned = false;
	const rawWithoutBotMention = rawContent.replace(
		new RegExp(`@\\*\\*${escapedRegExp(botFullName)}\\*\\*`, "gi"),
		() => {
			mentioned = true;
			return "";
		},
	).trim();
	if (rawContent) {
		return {
			text: rawWithoutBotMention,
			mentioned: mentioned
				|| message?.is_mentioned === true
				|| message?.flags?.includes?.("mentioned")
				|| message?.flags?.includes?.("wildcard_mentioned"),
		};
	}

	const rendered = typeof message?.content === "string" ? message.content : "";
	const mentionPattern = new RegExp(
		`<[^>]+data-user-id=(?:"${botUserId}"|'${botUserId}')[^>]*>[\\s\\S]*?<\\/[^>]+>`,
		"gi",
	);
	const renderedWithoutBotMention = rendered.replace(mentionPattern, () => {
		mentioned = true;
		return "";
	});
	return {
		text: renderedWithoutBotMention.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
		mentioned,
	};
}

function isPriorityStop(message, botUserId, botFullName) {
	if (!["private", "stream"].includes(message?.type)) return false;
	const candidate = priorityStopText(message, botUserId, botFullName);
	if (candidate.text.toLowerCase() !== "stop") return false;
	return message.type === "private" || candidate.mentioned;
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ZulipResidentBridge {
	constructor(config) {
		this.zulipUrl = httpUrl(config.zulipUrl, "zulipUrl");
		this.zulipEmail = requiredText(config.zulipEmail, "zulipEmail").toLowerCase();
		this.zulipApiKey = requiredText(config.zulipApiKey, "zulipApiKey");
		const configuredChannelIds = config.allowedChannelIds
			?? (config.channelId === undefined ? undefined : [config.channelId]);
		this.allowedChannelIds = configuredChannelIds === undefined
			? null
			: new Set(Array.from(configuredChannelIds, (channelId) => positiveId(channelId, "allowed channel ID")));
		this.allowedDmUserIds = config.allowedDmUserIds === undefined
			? null
			: new Set(Array.from(config.allowedDmUserIds, (userId) => positiveId(userId, "allowed DM user ID")));
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
		this.botFullName = null;
		this.knownUserIds = new Set();
		this.botUserIds = new Set();
		this.subscribedChannels = new Map();
		this.knownDirectConversations = new Set();
		this.queueId = null;
		this.lastEventId = -1;
		this.lastMessageId = null;
		this.pollPromise = null;
		this.stopped = true;
		this.pendingReceipts = new Map();
		this.liveDeliveryTail = Promise.resolve();
		this.liveDeliveryTasks = new Set();
		this.liveDeliveryRecords = [];
		this.scheduledLiveMessageIds = new Set();
	}

	async start() {
		if (this.server) throw new Error("Zulip resident bridge is already started");
		const me = await this.nativeRequest("users/me");
		this.botUserId = positiveId(me.user_id, "Zulip bot user ID");
		this.botFullName = requiredText(me.full_name, "Zulip bot full name");
		if (me.is_bot !== true) throw new Error("Zulip resident bridge identity must be a bot");
		await this.refreshUserIdentityCache();
		if (!this.botUserIds.has(this.botUserId)) {
			throw new Error("Zulip user directory omitted the resident bridge bot identity");
		}
		await this.refreshSubscriptions();
		if (this.allowedChannelIds) {
			for (const channelId of this.allowedChannelIds) {
				if (!this.subscribedChannels.has(channelId)) {
					throw new Error(`Zulip bot is not subscribed to allowed channel ${channelId}`);
				}
			}
		}

		await this.listen();
		try {
			await this.registerQueue();
			const state = this.loadState();
			this.lastMessageId = state.lastMessageId;
			this.knownDirectConversations = state.knownDirectConversations;
			if (this.lastMessageId === null) {
				this.lastMessageId = await this.newestVisibleMessageId();
				this.saveState();
			} else {
				// The proxy must remain available while a resident restarts. Catch-up
				// deliveries already have their own durable retry lane, so mark the
				// bridge live before scheduling them instead of making startup depend
				// on the resident inbound endpoint being ready.
				this.stopped = false;
				await this.catchUp();
			}
			this.stopped = false;
			this.pollPromise = this.pollLoop();
		} catch (error) {
			this.stopped = true;
			await this.closeServer();
			throw error;
		}
	}

	async stop() {
		this.stopped = true;
		await this.pollPromise;
		this.pollPromise = null;
		for (const pending of this.pendingReceipts.values()) {
			pending.reject(new Error("Zulip resident bridge stopped"));
		}
		this.pendingReceipts.clear();
		await Promise.allSettled(Array.from(this.liveDeliveryTasks));
		this.liveDeliveryTail = Promise.resolve();
		this.liveDeliveryRecords = [];
		this.scheduledLiveMessageIds.clear();
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
		if (body.status === "running") pending.resolveRunning();
		else if (body.status === "completed") pending.resolveCompleted();
		else if (body.status === "failed") pending.reject(new Error(String(body.error || "resident delivery failed")));
		else if (body.status !== "heartbeat") {
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
			await this.refreshSubscriptions();
			json(response, 200, {
				result: "success",
				msg: "",
				streams: Array.from(this.subscribedChannels.values())
					.filter((channel) => this.channelIsInScope(channel.stream_id))
					.map((channel) => ({
						stream_id: channel.stream_id,
						name: channel.name,
						topics_policy: channel.topics_policy,
					})),
			});
			return;
		}
		if (request.method === "POST" && providerPath === "messages") {
			const body = new URLSearchParams((await readRawBody(request, 2 * 1024 * 1024)).toString("utf8"));
			const content = body.get("content")?.trim() || "";
			if (!content) {
				json(response, 400, { result: "error", msg: "content_required" });
				return;
			}
			if (body.get("type") === "channel") {
				const channelId = positiveId(body.get("to"), "Zulip outbound channel ID");
				await this.refreshSubscriptions();
				if (!this.channelIsInScope(channelId)) {
					json(response, 403, { result: "error", msg: "zulip_channel_scope_denied" });
					return;
				}
				const topic = body.get("topic") || "";
				json(response, 200, await this.nativeRequest("messages", {
					method: "POST",
					body: new URLSearchParams({ type: "channel", to: String(channelId), topic, content }),
				}));
				return;
			}
			if (body.get("type") === "direct") {
				const recipientIds = directRecipientIds(body.get("to"), this.botUserId);
				const conversation = directConversationKey(recipientIds);
				if (!this.knownDirectConversations.has(conversation)) {
					json(response, 403, { result: "error", msg: "zulip_direct_scope_denied" });
					return;
				}
				json(response, 200, await this.nativeRequest("messages", {
					method: "POST",
					body: new URLSearchParams({ type: "direct", to: JSON.stringify(recipientIds), content }),
				}));
				return;
			}
			json(response, 403, { result: "error", msg: "zulip_message_scope_denied" });
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
		if (Number(message?.sender_id) !== this.botUserId) {
			throw new Error("Zulip bridge may only mutate its bot's messages");
		}
		if (message?.type === "stream") {
			await this.requireSubscribedChannel(positiveId(message.stream_id, "Zulip message channel ID"));
			return message;
		}
		if (message?.type === "private") {
			const conversation = directConversationFromMessage(message, this.botUserId);
			if (!this.knownDirectConversations.has(conversation)) {
				throw new Error("Zulip direct message is outside the bridge's established conversations");
			}
			return message;
		}
		throw new Error("Zulip message has an unsupported conversation type");
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

	/**
	 * Release each ordered delivery lane once the resident reports that the
	 * event has actually entered its run/steer/control route. Full-turn receipts
	 * continue independently so cursor commits remain durable and ordered.
	 */
	scheduleLiveMessage(message) {
		const messageId = positiveId(message?.id, "Zulip message ID");
		if (messageId <= (this.lastMessageId || 0) || this.scheduledLiveMessageIds.has(messageId)) return;
		this.scheduledLiveMessageIds.add(messageId);
		const record = { messageId, completed: false };
		this.liveDeliveryRecords.push(record);
		this.liveDeliveryRecords.sort((left, right) => left.messageId - right.messageId);

		const deliver = () => this.processLiveMessage(message, record);
		const priority = isPriorityStop(message, this.botUserId, this.botFullName);
		const task = priority ? deliver() : this.liveDeliveryTail.then(deliver);
		if (!priority) this.liveDeliveryTail = task;
		this.trackLiveDeliveryTask(task);
	}

	async processLiveMessage(message, record) {
		while (!this.stopped) {
			try {
				const delivery = await this.ingestMessage(message, false);
				if (!delivery) {
					record.completed = true;
					this.flushCompletedLiveMessages();
					return;
				}
				this.trackLiveDeliveryTask(this.completeLiveMessage(message, record, delivery.completed));
				return;
			} catch (error) {
				if (this.stopped) return;
				console.error(
					`zulip-resident-bridge: delivery ${record.messageId} failed; retrying:`,
					error instanceof Error ? error.message : String(error),
				);
				await sleep(500);
			}
		}
	}

	async completeLiveMessage(message, record, completed) {
		try {
			await completed;
			record.completed = true;
			this.flushCompletedLiveMessages();
		} catch (error) {
			if (this.stopped) return;
			console.error(
				`zulip-resident-bridge: completion ${record.messageId} failed; reconciling:`,
				error instanceof Error ? error.message : String(error),
			);
			await sleep(500);
			await this.processLiveMessage(message, record);
		}
	}

	trackLiveDeliveryTask(task) {
		this.liveDeliveryTasks.add(task);
		void task.then(
			() => this.liveDeliveryTasks.delete(task),
			() => this.liveDeliveryTasks.delete(task),
		);
	}

	flushCompletedLiveMessages() {
		while (this.liveDeliveryRecords[0]?.completed) {
			const record = this.liveDeliveryRecords.shift();
			this.scheduledLiveMessageIds.delete(record.messageId);
			this.advanceMessageCursor(record.messageId);
		}
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
					if (event.type === "message") this.scheduleLiveMessage(event.message);
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

	async refreshUserIdentityCache() {
		const result = await this.nativeRequest("users", {
			query: {
				client_gravatar: "false",
				include_custom_profile_fields: "false",
			},
		});
		if (!Array.isArray(result.members)) {
			throw new Error("Zulip user directory returned an invalid member list");
		}
		const knownUserIds = new Set();
		const botUserIds = new Set();
		for (const member of result.members) {
			const userId = positiveId(member?.user_id, "Zulip directory user ID");
			knownUserIds.add(userId);
			if (member?.is_bot === true) botUserIds.add(userId);
		}
		this.knownUserIds = knownUserIds;
		this.botUserIds = botUserIds;
	}

	async senderIsBot(senderId) {
		if (!this.knownUserIds.has(senderId)) await this.refreshUserIdentityCache();
		if (!this.knownUserIds.has(senderId)) {
			throw new Error(`Zulip sender ${senderId} is absent from the private user identity cache`);
		}
		return this.botUserIds.has(senderId);
	}

	async refreshSubscriptions() {
		const result = await this.nativeRequest("users/me/subscriptions");
		if (!Array.isArray(result.subscriptions)) {
			throw new Error("Zulip subscriptions endpoint returned an invalid subscription list");
		}
		const channels = new Map();
		for (const subscription of result.subscriptions) {
			const streamId = positiveId(subscription?.stream_id, "Zulip subscription channel ID");
			channels.set(streamId, subscription);
		}
		this.subscribedChannels = channels;
	}

	channelIsInScope(channelId) {
		return this.subscribedChannels.has(channelId)
			&& (this.allowedChannelIds === null || this.allowedChannelIds.has(channelId));
	}

	async requireSubscribedChannel(channelId) {
		await this.refreshSubscriptions();
		if (!this.channelIsInScope(channelId)) {
			throw new Error(`Zulip channel ${channelId} is not an allowed current subscription`);
		}
		return this.subscribedChannels.get(channelId);
	}

	async ingestMessage(message, advanceCursor = true) {
		const messageId = positiveId(message?.id, "Zulip message ID");
		const senderId = positiveId(message?.sender_id, "Zulip sender ID");
		const complete = () => {
			if (advanceCursor) this.advanceMessageCursor(messageId);
		};

		if (message?.type === "stream") {
			const channelId = positiveId(message.stream_id, "Zulip channel ID");
			if (!this.channelIsInScope(channelId)) await this.refreshSubscriptions();
			if (!this.channelIsInScope(channelId)) {
				complete();
				return;
			}
		} else if (message?.type === "private") {
			if (this.allowedDmUserIds && !this.allowedDmUserIds.has(senderId)) {
				complete();
				return;
			}
			this.knownDirectConversations.add(directConversationFromMessage(message, this.botUserId));
			this.saveState();
		} else {
			complete();
			return;
		}

		if (senderId === this.botUserId) {
			complete();
			return;
		}
		const senderIsBot = await this.senderIsBot(senderId);
		const detail = await this.nativeRequest(`messages/${messageId}`);
		const rawContent = typeof detail.message?.raw_content === "string"
			? detail.message.raw_content
			: undefined;
		const flags = Array.isArray(detail.message?.flags)
			? detail.message.flags.filter((flag) => typeof flag === "string")
			: undefined;
		const isMentioned = detail.message?.is_mentioned === true ? true : undefined;
		const delivery = await this.deliver({
			...message,
			sender_is_bot: senderIsBot,
			...(rawContent === undefined ? {} : { raw_content: rawContent }),
			...(flags === undefined ? {} : { flags }),
			...(isMentioned === undefined ? {} : { is_mentioned: isMentioned }),
		});
		if (advanceCursor) await delivery.completed;
		complete();
		return delivery;
	}

	async deliver(message) {
		const leaseToken = randomUUID();
		let resolveAccepted;
		let rejectAccepted;
		let resolveCompleted;
		let rejectCompleted;
		let settled = false;
		const accepted = new Promise((resolve, reject) => {
			resolveAccepted = resolve;
			rejectAccepted = reject;
		});
		const completed = new Promise((resolve, reject) => {
			resolveCompleted = resolve;
			rejectCompleted = reject;
		});
		// A pre-acceptance network failure rejects both promises. Attach handlers
		// now so neither can become an unhandled rejection before the retry lane
		// observes the thrown delivery error.
		void accepted.catch(() => {});
		void completed.catch(() => {});
		const acceptTimer = setTimeout(() => {
			pending.reject(new Error(`Zulip resident delivery ${message.id} was not routed in time`));
		}, DELIVERY_ACCEPT_TIMEOUT_MS);
		acceptTimer.unref();
		const completionTimer = setTimeout(() => {
			pending.reject(new Error(`Zulip resident delivery ${message.id} timed out`));
		}, DELIVERY_TIMEOUT_MS);
		completionTimer.unref();
		const cleanup = () => {
			clearTimeout(acceptTimer);
			clearTimeout(completionTimer);
			this.pendingReceipts.delete(leaseToken);
		};
		const pending = {
			resolveRunning: () => {
				if (settled) return;
				clearTimeout(acceptTimer);
				resolveAccepted();
			},
			resolveCompleted: () => {
				if (settled) return;
				settled = true;
				resolveAccepted();
				resolveCompleted();
				cleanup();
			},
			reject: (error) => {
				if (settled) return;
				settled = true;
				rejectAccepted(error);
				rejectCompleted(error);
				cleanup();
			},
		};
		this.pendingReceipts.set(leaseToken, pending);
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
			await accepted;
			return { completed };
		} catch (error) {
			pending.reject(error);
			throw error;
		}
	}

	loadState() {
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
			const lastMessageId = positiveId(parsed.lastMessageId, "stored Zulip message ID");
			const knownDirectConversations = new Set();
			for (const value of parsed.knownDirectConversations || []) {
				if (typeof value !== "string" || !/^dm:[1-9]\d*(?:,[1-9]\d*)*$/.test(value)) {
					throw new Error("stored Zulip direct conversation is invalid");
				}
				knownDirectConversations.add(value);
			}
			return { lastMessageId, knownDirectConversations };
		} catch (error) {
			if (error?.code === "ENOENT") {
				return { lastMessageId: null, knownDirectConversations: new Set() };
			}
			throw new Error("Zulip resident bridge state is unreadable");
		}
	}

	saveState() {
		if (this.lastMessageId === null) return;
		mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.statePath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({
			version: 2,
			lastMessageId: this.lastMessageId,
			knownDirectConversations: Array.from(this.knownDirectConversations).sort(),
		})}\n`, { mode: 0o600 });
		renameSync(temporary, this.statePath);
	}

	advanceMessageCursor(messageId) {
		this.lastMessageId = Math.max(this.lastMessageId || 0, messageId);
		this.saveState();
	}

	async newestVisibleMessageId() {
		const result = await this.visibleMessages({
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
		let anchor = this.lastMessageId;
		while (true) {
			const result = await this.visibleMessages({
				anchor: String(anchor),
				num_before: "0",
				num_after: "100",
				include_anchor: "false",
			});
			const messages = (result.messages || [])
				.filter((message) => Number(message.id) > anchor)
				.sort((left, right) => Number(left.id) - Number(right.id));
			if (messages.length === 0) return;
			for (const message of messages) {
				if (this.stopped) await this.ingestMessage(message);
				else this.scheduleLiveMessage(message);
			}
			anchor = Number(messages.at(-1).id);
			if (messages.length < 100) return;
		}
	}

	visibleMessages(query) {
		return this.nativeRequest("messages", { query });
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
