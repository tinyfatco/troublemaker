import { createHash } from "node:crypto";
import WebSocket from "ws";
import { bearerMatches } from "./security.mjs";

async function readRawBody(request, maximum = 25 * 1024 * 1024) {
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximum) throw new Error("Rocket.Chat proxy request exceeds limit");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function readBody(request, maximum = 2 * 1024 * 1024) {
	return JSON.parse((await readRawBody(request, maximum)).toString("utf8"));
}

function json(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	response.end(JSON.stringify(value));
}

function messageId(value) {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value)
		? value
		: null;
}

function contextParts(contextId) {
	const [targetId, principalHash] = contextId.split(":");
	if (!targetId || !principalHash) throw new Error("Rocket.Chat binding has an invalid context ID");
	return { targetId, principalHash };
}

function isTinyFatProjection(message) {
	const metadata = message?.customFields?.tinyfat;
	return Boolean(metadata && typeof metadata === "object" && metadata.eventId);
}

export class RocketChatGateway {
	constructor({ config, store, provisioner, scheduler }) {
		this.config = config;
		this.store = store;
		this.provisioner = provisioner;
		this.scheduler = scheduler;
		this.websocket = null;
		this.stopped = true;
		this.reconnectTimer = null;
		this.reconnectDelayMilliseconds = 1_000;
	}

	async start() {
		if (!this.config.rocketChat) return;
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
			const parsed = new URL(this.config.rocketChat.url);
			const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
			const websocket = new WebSocket(
				`${protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}/websocket`,
			);
			this.websocket = websocket;
			let authenticated = false;
			let settled = false;
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (error) reject(error);
				else resolvePromise();
			};
			const timeout = setTimeout(() => {
				finish(new Error("Rocket.Chat gateway authentication timed out"));
				websocket.terminate();
			}, 10_000);
			websocket.on("open", () => {
				websocket.send(JSON.stringify({ msg: "connect", version: "1", support: ["1"] }));
			});
			websocket.on("message", (raw) => {
				let event;
				try {
					event = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (event.msg === "ping") {
					websocket.send(JSON.stringify({ msg: "pong", ...(event.id ? { id: event.id } : {}) }));
					return;
				}
				if (event.msg === "connected") {
					websocket.send(JSON.stringify({
						msg: "method",
						method: "login",
						params: [{ resume: this.config.rocketChat.adminToken }],
						id: "hostd-login",
					}));
					return;
				}
				if (event.msg === "result" && event.id === "hostd-login") {
					if (event.error) {
						finish(new Error(event.error.reason || "Rocket.Chat gateway authentication failed"));
						websocket.close();
						return;
					}
					authenticated = true;
					websocket.send(JSON.stringify({
						msg: "sub",
						id: "hostd-customer-rooms",
						name: "stream-room-messages",
						params: ["__my_messages__", false],
					}));
					return;
				}
				if (
					event.msg === "ready"
					&& Array.isArray(event.subs)
					&& event.subs.includes("hostd-customer-rooms")
				) {
					this.reconnectDelayMilliseconds = 1_000;
					console.log("troublemaker-hostd: host Rocket.Chat ingress connected");
					finish();
					return;
				}
				if (event.msg === "changed" && event.collection === "stream-room-messages") {
					const message = event.fields?.args?.[0];
					void this.ingestMessage(message).catch((error) => {
						console.error(
							"troublemaker-hostd: Rocket.Chat message ingress failed:",
							error instanceof Error ? error.message : String(error),
						);
					});
				}
			});
			websocket.on("error", (error) => {
				if (!authenticated) finish(error);
				else console.error("troublemaker-hostd: Rocket.Chat gateway error:", error.message);
			});
			websocket.on("close", () => {
				clearTimeout(timeout);
				if (this.websocket === websocket) this.websocket = null;
				if (!settled) finish(new Error("Rocket.Chat gateway closed before authentication"));
				if (!this.stopped && authenticated) this.scheduleReconnect();
			});
		});
	}

	scheduleReconnect() {
		if (this.stopped || this.reconnectTimer) return;
		const delay = this.reconnectDelayMilliseconds;
		this.reconnectDelayMilliseconds = Math.min(delay * 2, 30_000);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect().catch((error) => {
				console.error(
					"troublemaker-hostd: Rocket.Chat reconnect failed:",
					error instanceof Error ? error.message : String(error),
				);
				this.scheduleReconnect();
			});
		}, delay);
	}

	async ingestMessage(message) {
		if (!messageId(message?._id) || !messageId(message?.rid) || !messageId(message?.u?._id)) return;
		if (message.t || isTinyFatProjection(message)) return;
		const binding = this.store.getRocketChatBindingByRoom(message.rid);
		if (!binding) return;
		if (
			message.u._id === binding.botUserId
			|| this.provisioner.isControlBotUser(message.u._id)
		) return;
		if (this.store.getEventByProviderMessage("rocket-chat", message._id)) return;
		const { targetId, principalHash } = contextParts(binding.contextId);
		const event = this.store.upsertEvent({
			id: `rocket-chat:${message._id}`,
			source: "rocket-chat",
			providerMessageId: message._id,
			providerThreadId: message.tmid || message._id,
			principalHash,
			targetId,
			contextId: binding.contextId,
			payload: { message },
		});
		this.scheduler?.pump();
		console.log(
			`troublemaker-hostd: queued Rocket.Chat message ${message._id} as awareness sequence ${event.awarenessSequence} for ${binding.contextId}`,
		);
	}

	async findProjectedMessage(binding, eventId) {
		const history = await this.provisioner.request("groups.history", {
			query: { roomId: binding.roomId, count: 100 },
			auth: binding.credentials,
		});
		return (history.messages ?? []).find(
			(message) => message?.customFields?.tinyfat?.eventId === eventId,
		);
	}

	async validateThread(binding, threadId) {
		if (!threadId) return;
		const result = await this.provisioner.request("chat.getMessage", {
			query: { msgId: threadId },
			auth: binding.credentials,
		});
		if (result.message?.rid !== binding.roomId) {
			throw new Error("Rocket.Chat thread is outside the bound customer room");
		}
	}

	async validateMessage(binding, messageIdentifier) {
		const id = messageId(messageIdentifier);
		if (!id) throw new Error("Rocket.Chat message ID is invalid");
		const result = await this.provisioner.request("chat.getMessage", {
			query: { msgId: id },
			auth: binding.credentials,
		});
		if (result.message?.rid !== binding.roomId) {
			throw new Error("Rocket.Chat message is outside the bound customer room");
		}
		return result.message;
	}

	async relayRaw(response, binding, endpoint, request, body) {
		const upstream = await fetch(`${this.config.rocketChat.url}/api/v1/${endpoint}`, {
			method: request.method,
			headers: {
				"X-Auth-Token": binding.credentials.authToken,
				"X-User-Id": binding.credentials.userId,
				...(request.headers["content-type"]
					? { "content-type": request.headers["content-type"] }
					: {}),
			},
			body,
			signal: AbortSignal.timeout(30_000),
		});
		const payload = Buffer.from(await upstream.arrayBuffer());
		response.writeHead(upstream.status, {
			"content-type": upstream.headers.get("content-type") || "application/octet-stream",
			"cache-control": "no-store",
		});
		response.end(payload);
	}

	async relayFile(response, binding, file) {
		const upstream = await fetch(
			`${this.config.rocketChat.url}/file-upload/${encodeURIComponent(file._id)}/${encodeURIComponent(file.name)}`,
			{
				headers: {
					"X-Auth-Token": binding.credentials.authToken,
					"X-User-Id": binding.credentials.userId,
				},
				signal: AbortSignal.timeout(30_000),
			},
		);
		const payload = Buffer.from(await upstream.arrayBuffer());
		response.writeHead(upstream.status, {
			"content-type": upstream.headers.get("content-type") || "application/octet-stream",
			"cache-control": "no-store",
		});
		response.end(payload);
	}

	async proxy(request, response, contextId, providerPath, expectedToken) {
		if (!bearerMatches(request.headers.authorization, expectedToken)) {
			json(response, 401, { success: false, error: "unauthorized" });
			return;
		}
		const binding = (
			await this.provisioner.runtimeBinding(contextId)
			?? await this.provisioner.ensureContext(contextId)
		);
		if (!binding) {
			json(response, 404, { success: false, error: "rocket_chat_context_not_provisioned" });
			return;
		}
		const parsed = new URL(providerPath, "http://hostd.invalid");
		const path = parsed.pathname;

		if (request.method === "GET" && path === "/me") {
			json(response, 200, await this.provisioner.request("me", {
				auth: binding.credentials,
			}));
			return;
		}
		if (request.method === "GET" && path === "/groups.info") {
			json(response, 200, await this.provisioner.request("groups.info", {
				query: { roomId: binding.roomId },
				auth: binding.credentials,
			}));
			return;
		}
		if (request.method === "GET" && path === "/groups.history") {
			const count = Math.max(1, Math.min(Number(parsed.searchParams.get("count")) || 50, 100));
			json(response, 200, await this.provisioner.request("groups.history", {
				query: {
					roomId: binding.roomId,
					count,
					...(parsed.searchParams.get("oldest")
						? { oldest: parsed.searchParams.get("oldest") }
						: {}),
				},
				auth: binding.credentials,
			}));
			return;
		}
		if (request.method === "GET" && path === "/chat.getThreadMessages") {
			const tmid = parsed.searchParams.get("tmid") || "";
			await this.validateThread(binding, tmid);
			json(response, 200, await this.provisioner.request("chat.getThreadMessages", {
				query: {
					tmid,
					count: Math.max(1, Math.min(Number(parsed.searchParams.get("count")) || 50, 100)),
				},
				auth: binding.credentials,
			}));
			return;
		}
		const fileMatch = path.match(
			/^\/files\/([a-zA-Z0-9_-]{8,128})\/([a-zA-Z0-9_-]{8,128})\/([^/]{1,768})$/,
		);
		if (request.method === "GET" && fileMatch) {
			let requestedName;
			try {
				requestedName = decodeURIComponent(fileMatch[3]);
			} catch {
				json(response, 400, { success: false, error: "rocket_chat_file_name_invalid" });
				return;
			}
			const message = await this.validateMessage(binding, fileMatch[1]);
			const files = [...(message.files ?? []), ...(message.file ? [message.file] : [])];
			const file = files.find(
				(candidate) => candidate?._id === fileMatch[2] && candidate?.name === requestedName,
			);
			if (!file) {
				json(response, 403, { success: false, error: "rocket_chat_file_scope_denied" });
				return;
			}
			await this.relayFile(response, binding, file);
			return;
		}
		if (request.method === "POST" && path === "/chat.update") {
			const input = await readBody(request);
			if (input.roomId !== binding.roomId) {
				json(response, 403, { success: false, error: "rocket_chat_room_scope_denied" });
				return;
			}
			await this.validateMessage(binding, input.msgId);
			const text = typeof input.text === "string" ? input.text.trim() : "";
			if (!text) {
				json(response, 400, { success: false, error: "text_required" });
				return;
			}
			json(response, 200, await this.provisioner.request("chat.update", {
				method: "POST",
				auth: binding.credentials,
				body: {
					roomId: binding.roomId,
					msgId: input.msgId,
					text,
				},
			}));
			return;
		}
		if (request.method === "POST" && path === "/chat.delete") {
			const input = await readBody(request);
			if (input.roomId !== binding.roomId) {
				json(response, 403, { success: false, error: "rocket_chat_room_scope_denied" });
				return;
			}
			await this.validateMessage(binding, input.msgId);
			json(response, 200, await this.provisioner.request("chat.delete", {
				method: "POST",
				auth: binding.credentials,
				body: {
					roomId: binding.roomId,
					msgId: input.msgId,
				},
			}));
			return;
		}
		const mediaMatch = path.match(/^\/rooms\.media\/([a-zA-Z0-9_-]{8,128})$/);
		if (request.method === "POST" && mediaMatch) {
			if (mediaMatch[1] !== binding.roomId) {
				json(response, 403, { success: false, error: "rocket_chat_room_scope_denied" });
				return;
			}
			if (!String(request.headers["content-type"] || "").startsWith("multipart/form-data;")) {
				json(response, 400, { success: false, error: "multipart_required" });
				return;
			}
			await this.relayRaw(
				response,
				binding,
				`rooms.media/${binding.roomId}`,
				request,
				await readRawBody(request),
			);
			return;
		}
		const mediaConfirmMatch = path.match(
			/^\/rooms\.mediaConfirm\/([a-zA-Z0-9_-]{8,128})\/([a-zA-Z0-9_-]{8,128})$/,
		);
		if (request.method === "POST" && mediaConfirmMatch) {
			if (mediaConfirmMatch[1] !== binding.roomId) {
				json(response, 403, { success: false, error: "rocket_chat_room_scope_denied" });
				return;
			}
			const input = await readBody(request);
			if (input.tmid) await this.validateThread(binding, input.tmid);
			json(response, 200, await this.provisioner.request(
				`rooms.mediaConfirm/${binding.roomId}/${mediaConfirmMatch[2]}`,
				{
					method: "POST",
					auth: binding.credentials,
					body: {
						msg: typeof input.msg === "string" ? input.msg : "",
						description: typeof input.description === "string" ? input.description : "",
						...(input.tmid ? { tmid: input.tmid } : {}),
						...(input.customFields && typeof input.customFields === "object"
							? { customFields: input.customFields }
							: {}),
					},
				},
			));
			return;
		}
		if (request.method === "POST" && path === "/chat.postMessage") {
			const input = await readBody(request);
			if (input.roomId !== binding.roomId) {
				json(response, 403, { success: false, error: "rocket_chat_room_scope_denied" });
				return;
			}
			const text = typeof input.text === "string" ? input.text.trim() : "";
			if (!text) {
				json(response, 400, { success: false, error: "text_required" });
				return;
			}
			const eventId = typeof input.tinyfatEventId === "string" ? input.tinyfatEventId : "";
			if (!/^[a-zA-Z0-9:_-]{12,160}$/.test(eventId)) {
				json(response, 400, { success: false, error: "tinyfat_event_id_required" });
				return;
			}
			const threadId = typeof input.tmid === "string" && input.tmid ? input.tmid : null;
			await this.validateThread(binding, threadId);
			const post = this.store.startRocketChatPost({
				eventId,
				contextId,
				threadId,
				textSha256: createHash("sha256").update(text).digest("hex"),
			});
			if (post.status === "completed" && post.providerMessageId) {
				json(response, 200, {
					success: true,
					duplicate: true,
					message: {
						_id: post.providerMessageId,
						rid: binding.roomId,
						msg: text,
						...(threadId ? { tmid: threadId } : {}),
					},
				});
				return;
			}
			const existing = await this.findProjectedMessage(binding, eventId);
			if (existing?._id) {
				this.store.completeRocketChatPost(eventId, existing._id);
				json(response, 200, { success: true, duplicate: true, message: existing });
				return;
			}
			if (!post.claimed) {
				json(response, 409, { success: false, error: "rocket_chat_send_in_progress" });
				return;
			}
			try {
				const created = await this.provisioner.request("chat.postMessage", {
					method: "POST",
					auth: binding.credentials,
					body: {
						roomId: binding.roomId,
						text,
						...(threadId ? { tmid: threadId } : {}),
						customFields: {
							tinyfat: {
								schema: 1,
								kind: "collaboration.message.recorded",
								eventId,
								customerChannelId: contextId,
								sequence: post.sequence,
								source: "rocket-chat",
								actorKind: "agent",
								actorId: contextParts(contextId).targetId,
								visibility: "channel",
							},
						},
					},
				});
				const createdId = messageId(created?.message?._id);
				if (!createdId) throw new Error("Rocket.Chat post response omitted the message ID");
				this.store.completeRocketChatPost(eventId, createdId);
				json(response, 200, created);
			} catch (error) {
				this.store.failRocketChatPost(eventId, error instanceof Error ? error.message : String(error));
				throw error;
			}
			return;
		}

		json(response, 403, { success: false, error: "rocket_chat_operation_denied" });
	}
}
