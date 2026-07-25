import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function opaqueSuffix(contextId) {
	return createHash("sha256").update(contextId).digest("hex").slice(0, 20);
}

function rocketId(value, label) {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
		throw new Error(`Rocket.Chat ${label} is invalid`);
	}
	return value;
}

function cleanMessage(value) {
	return typeof value === "string"
		? value.replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500)
		: "";
}

function safeInlineCode(value) {
	return cleanMessage(value).replaceAll("`", "'").replaceAll("@", "＠");
}

function ledgerBody(value) {
	if (typeof value !== "string") return "_No body._";
	const cleaned = value
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.replaceAll("@", "＠")
		.trim();
	if (!cleaned) return "_No body._";
	const maximum = 10_000;
	const bounded = cleaned.length > maximum
		? `${cleaned.slice(0, maximum)}\n\n[Body truncated by TINYFAT]`
		: cleaned;
	return bounded.split("\n").map((line) => `> ${line}`).join("\n");
}

function inboundBody(payload, providerMessageId) {
	const thread = Array.isArray(payload?.thread) ? payload.thread : [];
	const message = thread.find((candidate) => candidate?.id === providerMessageId)
		?? payload?.message;
	return ledgerBody(message?.body);
}

function inboundPlainText(payload, providerMessageId) {
	const thread = Array.isArray(payload?.thread) ? payload.thread : [];
	const message = thread.find((candidate) => candidate?.id === providerMessageId)
		?? payload?.message;
	if (typeof message?.body !== "string") return "";
	return message.body
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.trim()
		.slice(0, 10_000);
}

function verifiedContextEmail(store, contextId, knownEmailsByPrincipalHash) {
	const record = store.getLatestContextEventPayload(contextId, "gmail");
	if (record?.payloadJson) {
		try {
			const sender = JSON.parse(record.payloadJson)?.sender;
			if (typeof sender === "string") {
				const normalized = sender.trim().toLowerCase();
				if (/^[^@\s]+@[^@\s]+$/.test(normalized)) return normalized;
			}
		} catch {
			// Fall through to the deterministic known-principal mapping.
		}
	}
	const principalHash = contextId.split(":")[1];
	return knownEmailsByPrincipalHash.get(principalHash) ?? null;
}

function awarenessMetadata(notification, outbound) {
	return {
		schema: 1,
		kind: outbound ? "message.outbound.delivered" : "message.inbound.recorded",
		eventId: notification.id,
		customerChannelId: notification.contextId,
		sequence: notification.sequence,
		source: "email",
		actorKind: outbound ? "agent" : "contact",
		actorId: outbound ? notification.contextId.split(":", 1)[0] : notification.principalHash,
		visibility: "channel",
		...(outbound ? { deliveryStatus: "delivered" } : {}),
	};
}

function contactEmails(contact) {
	return (contact?.emails ?? []).map((email) => {
		if (typeof email === "string") return email.trim().toLowerCase();
		return typeof email?.address === "string" ? email.address.trim().toLowerCase() : "";
	}).filter(Boolean);
}

function userRoles(user) {
	return Array.isArray(user?.roles)
		? user.roles.filter((role) => typeof role === "string" && role)
		: [];
}

function credentialsFrom(value, expectedUserId) {
	if (
		value?.userId === expectedUserId
		&& typeof value?.authToken === "string"
		&& value.authToken
	) {
		return {
			userId: expectedUserId,
			authToken: value.authToken,
			username: typeof value.username === "string" ? value.username : undefined,
		};
	}
	return null;
}

export class RocketChatProvisioner {
	constructor(config, store, { knownEmailsByPrincipalHash = new Map() } = {}) {
		this.config = config;
		this.store = store;
		this.knownEmailsByPrincipalHash = knownEmailsByPrincipalHash;
		this.contextPromises = new Map();
		this.agentPromises = new Map();
		this.controlUserPromise = null;
	}

	async request(endpoint, {
		method = "GET",
		body,
		query,
		allowMissing = false,
		auth,
	} = {}) {
		const url = new URL(`${this.config.url}/api/v1/${endpoint}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		const response = await fetch(url, {
			method,
			headers: {
				"X-Auth-Token": auth?.authToken ?? this.config.adminToken,
				"X-User-Id": auth?.userId ?? this.config.adminUserId,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		let payload = {};
		if (text) {
			try {
				payload = JSON.parse(text);
			} catch {
				throw new Error(`Rocket.Chat ${method} ${endpoint} returned invalid JSON`);
			}
		}
		if (
			allowMissing
			&& (
					response.status === 404
					|| [
						"error-room-not-found",
						"error-invalid-room",
						"error-user-not-found",
						"error-invalid-user",
						"error-invalid-message",
					].includes(payload?.errorType)
					|| (endpoint === "users.info" && payload?.error === "User not found.")
					|| (
						allowMissing
						&& ["invalid-message", "invalid-room", "room-closed"].includes(payload?.error)
					)
				)
		) {
			return null;
		}
		if (!response.ok || payload?.success !== true) {
			const detail = cleanMessage(payload?.error ?? payload?.message ?? payload?.errorType);
			throw new Error(
				`Rocket.Chat ${method} ${endpoint} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			);
		}
		return payload;
	}

	agentSecretPath(contextId) {
		return join(this.config.credentialsDirectory, `${opaqueSuffix(contextId)}.json`);
	}

	controlSecretPath() {
		return join(this.config.credentialsDirectory, "tinyfat-control-plane.json");
	}

	async readCredentials(path, userId) {
		try {
			return credentialsFrom(JSON.parse(await readFile(path, "utf8")), userId);
		} catch (error) {
			if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
			throw error;
		}
	}

	async credentialsAreValid(credentials) {
		if (!credentials) return false;
		try {
			const me = await this.request("me", { auth: credentials });
			return me?._id === credentials.userId;
		} catch {
			return false;
		}
	}

	async saveCredentials(path, credentials) {
		await mkdir(this.config.credentialsDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.config.credentialsDirectory, 0o700);
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify(credentials)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
	}

	async login(username, password) {
		const response = await fetch(`${this.config.url}/api/v1/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ user: username, password }),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		let payload = {};
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new Error("Rocket.Chat login returned invalid JSON");
		}
		if (
			!response.ok
			|| payload?.status !== "success"
			|| typeof payload?.data?.userId !== "string"
			|| typeof payload?.data?.authToken !== "string"
		) {
			const detail = cleanMessage(payload?.message ?? payload?.error);
			throw new Error(`Rocket.Chat login failed${detail ? `: ${detail}` : ""}`);
		}
		return {
			userId: payload.data.userId,
			authToken: payload.data.authToken,
			username,
		};
	}

	async ensureCredentials(path, user) {
		const stored = await this.readCredentials(path, user._id);
		if (await this.credentialsAreValid(stored)) return stored;

		let credentials;
		if (this.config.createTokensSecret) {
			const created = await this.request("users.createToken", {
				method: "POST",
				body: {
					userId: user._id,
					secret: this.config.createTokensSecret,
				},
			});
			credentials = credentialsFrom({
				...created?.data,
				username: user.username,
			}, user._id);
			if (!credentials) {
				throw new Error("Rocket.Chat users.createToken returned invalid credentials");
			}
		} else if (user.bootstrapPassword) {
			credentials = await this.login(user.username, user.bootstrapPassword);
		} else {
			throw new Error(
				`Rocket.Chat bot ${user.username} exists without usable host credentials; `
				+ "configure rocketChat.createTokensSecretEnv or recreate this host-owned bot",
			);
		}
		if (credentials.userId !== user._id) {
			throw new Error("Rocket.Chat login returned credentials for the wrong user");
		}
		await this.saveCredentials(path, credentials);
		return credentials;
	}

	async ensureBotUser(
		username,
		displayName,
		description,
		requiredRoles = ["user", "bot"],
	) {
		let result = await this.request("users.info", {
			query: { username },
			allowMissing: true,
		});
		let user = result?.user;
		let bootstrapPassword;
		if (!user) {
			bootstrapPassword = `${randomBytes(48).toString("base64url")}aA1!`;
			const created = await this.request("users.create", {
				method: "POST",
				body: {
					email: `${username}@agents.tinyfat.invalid`,
					name: displayName,
					password: bootstrapPassword,
					username,
					active: true,
					bio: description,
					roles: requiredRoles,
					joinDefaultChannels: false,
					requirePasswordChange: false,
					sendWelcomeEmail: false,
					verified: true,
				},
			});
			user = created?.user;
		}
		const id = rocketId(user?._id, "bot user ID");
		if (user?.username !== username) {
			throw new Error(`Rocket.Chat username ${username} resolved to an unexpected user`);
		}
		const existingRoles = userRoles(user);
		const roles = [...new Set([...existingRoles, ...requiredRoles])];
		if (user.name !== displayName || user.active === false) {
			const updated = await this.request("users.update", {
				method: "POST",
				body: {
					userId: id,
					data: {
						name: displayName,
						active: true,
						requirePasswordChange: false,
					},
				},
			});
			user = updated?.user ?? { ...user, name: displayName, active: true };
		}
		for (const roleId of requiredRoles) {
			if (existingRoles.includes(roleId)) continue;
			await this.request("roles.addUserToRole", {
				method: "POST",
				body: { username, roleId },
			});
		}
		return {
			...user,
			_id: id,
			username,
			name: displayName,
			roles,
			...(bootstrapPassword ? { bootstrapPassword } : {}),
		};
	}

	async ensureAgent(contextId) {
		const pending = this.agentPromises.get(contextId);
		if (pending) return pending;
		const promise = (async () => {
			const username = `${this.config.agentUsernamePrefix}-${opaqueSuffix(contextId)}`;
			const user = await this.ensureBotUser(
				username,
				this.config.agentDisplayName,
				"Private customer-relationship Operator runtime",
				["user", "bot", "livechat-agent"],
			);
			const credentials = await this.ensureCredentials(this.agentSecretPath(contextId), user);
			const { bootstrapPassword: _bootstrapPassword, ...publicUser } = user;
			return { user: publicUser, credentials };
		})();
		this.agentPromises.set(contextId, promise);
		try {
			return await promise;
		} finally {
			if (this.agentPromises.get(contextId) === promise) this.agentPromises.delete(contextId);
		}
	}

	async ensureControlUser() {
		if (this.controlUserPromise) return this.controlUserPromise;
		this.controlUserPromise = (async () => {
			const user = await this.ensureBotUser(
				this.config.notifierUsername,
				this.config.notifierDisplayName,
				"TinyFat host-owned customer-channel router",
			);
			const credentials = await this.ensureCredentials(this.controlSecretPath(), user);
			this.store.setMeta("rocket-chat:control_bot_user_id", user._id);
			const { bootstrapPassword: _bootstrapPassword, ...publicUser } = user;
			return { user: publicUser, credentials };
		})();
		try {
			return await this.controlUserPromise;
		} finally {
			this.controlUserPromise = null;
		}
	}

	isControlBotUser(userId) {
		return Boolean(userId && userId === this.store.getMeta("rocket-chat:control_bot_user_id"));
	}

	async ensureRoomMember(roomId, user) {
		const result = await this.request("groups.members", {
			query: { roomId, count: 100 },
		});
		if ((result.members ?? []).some((member) => member?._id === user._id)) return;
		await this.request("groups.invite", {
			method: "POST",
			body: { roomId, userId: user._id },
		});
	}

	async runtimeBinding(contextId) {
		const binding = this.store.getRocketChatBinding(contextId);
		if (!binding?.botUserId || !binding?.botUsername) return null;
		const credentials = await this.readCredentials(
			this.agentSecretPath(contextId),
			binding.botUserId,
		);
		if (!(await this.credentialsAreValid(credentials))) return null;
		return { ...binding, credentials };
	}

	async ensureContext(contextId, { reconcile = false } = {}) {
		const pending = this.contextPromises.get(contextId);
		if (pending) return pending;
		const promise = this.ensureContextInner(contextId, { reconcile });
		this.contextPromises.set(contextId, promise);
		try {
			return await promise;
		} finally {
			if (this.contextPromises.get(contextId) === promise) {
				this.contextPromises.delete(contextId);
			}
		}
	}

	async ensureContextInner(contextId, { reconcile = false } = {}) {
		const displayName = verifiedContextEmail(
			this.store,
			contextId,
			this.knownEmailsByPrincipalHash,
		);
		const contactId = displayName ? await this.ensureContact(displayName) : null;
		const agent = await this.ensureAgent(contextId);
		const control = await this.ensureControlUser();
		const existing = this.store.getRocketChatBinding(contextId);
		if (
			existing
			&& !reconcile
			&& existing.contactId === contactId
			&& existing.botUserId === agent.user._id
			&& existing.botUsername === agent.user.username
		) {
			await this.ensureRoomMember(existing.roomId, agent.user);
			await this.ensureRoomMember(existing.roomId, control.user);
			return {
				...existing,
				credentials: agent.credentials,
				platform: "rocket-chat",
			};
		}

		const roomName = `customer-${opaqueSuffix(contextId)}`;
		const roomCustomFields = {
			tinyfat: {
				schema: 1,
				kind: "customer-channel",
				customerChannelId: contextId,
				...(contactId ? { omnichannelContactId: contactId } : {}),
				displayName: displayName ?? `Customer ${opaqueSuffix(contextId).slice(-8)}`,
				status: "active",
			},
		};
		let group = await this.request("groups.info", {
			query: { roomName },
			allowMissing: true,
		});
		if (!group) {
			group = await this.request("groups.create", {
				method: "POST",
				body: {
					name: roomName,
					members: [
						...new Set([
							...this.config.memberUsernames,
							agent.user.username,
							control.user.username,
						]),
					],
					readOnly: false,
					customFields: roomCustomFields,
					extraData: {
						broadcast: false,
						encrypted: false,
						topic: displayName
							? `Customer relationship: ${displayName}`
							: `Customer relationship: ${opaqueSuffix(contextId).slice(-8)}`,
					},
				},
			});
		} else if (existing?.contactId !== contactId) {
			group = await this.request("groups.setCustomFields", {
				method: "POST",
				body: {
					roomId: group.group._id,
					customFields: roomCustomFields,
				},
			});
		}
		const room = group.group;
		const roomId = rocketId(room?._id, "room ID");
		if (room?.t !== "p") throw new Error(`Rocket.Chat room ${roomName} is not private`);
		await this.ensureRoomMember(roomId, agent.user);
		await this.ensureRoomMember(roomId, control.user);
		const binding = this.store.upsertRocketChatBinding({
			contextId,
			contactId,
			roomId,
			roomName: room.name ?? roomName,
			botUserId: agent.user._id,
			botUsername: agent.user.username,
			channelDisplayName: displayName,
		});
		return {
			...binding,
			credentials: agent.credentials,
			platform: "rocket-chat",
		};
	}

	async ensureContact(email) {
		const normalized = email.trim().toLowerCase();
		const result = await this.request("omnichannel/contacts.search", {
			query: { searchText: normalized, unknown: false, count: 100 },
		});
		const exact = (result.contacts ?? []).filter((contact) => contactEmails(contact).includes(normalized));
		if (exact.length > 1) {
			throw new Error("Rocket.Chat contact identity search returned multiple exact matches");
		}
		if (exact.length === 1) return rocketId(exact[0]._id, "contact ID");
		const created = await this.request("omnichannel/contacts", {
			method: "POST",
			body: {
				name: normalized,
				emails: [normalized],
				phones: [],
			},
		});
		return rocketId(created?.contactId, "created contact ID");
	}

	async ensureOmnichannelConversation(notification, binding) {
		if (notification.source !== "gmail") return null;
		const payload = JSON.parse(notification.payloadJson || "{}");
		const email = verifiedContextEmail(
			this.store,
			notification.contextId,
			this.knownEmailsByPrincipalHash,
		);
		if (!email || !binding.contactId) return null;
		const source = "gmail";
		const providerThreadId = cleanMessage(notification.providerThreadId);
		if (!providerThreadId) throw new Error("email notification omitted its provider thread ID");
		let conversation = this.store.getRocketChatOmnichannelConversation(
			source,
			providerThreadId,
		);
		if (conversation && conversation.contextId !== notification.contextId) {
			throw new Error("Rocket.Chat Omnichannel thread is bound to another customer context");
		}
		if (conversation) {
			const current = await this.request("livechat/room", {
				query: {
					token: conversation.visitorToken,
					rid: conversation.roomId,
				},
				allowMissing: true,
			});
			if (current?.room?.open !== false) {
				await this.ensureOmnichannelAssignment(
					conversation.roomId,
					current?.room,
					binding,
				);
				return conversation;
			}
		}

		const visitorToken = conversation?.visitorToken ?? randomBytes(32).toString("base64url");
		const username = `customer-${opaqueSuffix(notification.contextId)}-${opaqueSuffix(providerThreadId).slice(0, 8)}`;
		const roomResult = await this.request("tinyfat/omnichannel/conversation", {
			method: "POST",
			body: {
				visitor: {
					token: visitorToken,
					name: email,
					email,
					username,
				},
				source: {
					type: "email",
					id: "tinyfat-gmail",
					label: "Email",
					destination: cleanMessage(payload?.metadata?.to) || this.config.notifierDisplayName,
				},
				agentId: binding.botUserId,
				verified: true,
			},
		});
		const visitorId = rocketId(roomResult?.visitor?._id, "Omnichannel visitor ID");
		const room = roomResult?.room;
		const roomId = rocketId(room?._id, "Omnichannel room ID");
		if (room?.t !== "l") throw new Error("Rocket.Chat created a non-Omnichannel customer conversation");
		if (room?.contactId !== binding.contactId) {
			throw new Error("Rocket.Chat Omnichannel conversation resolved to the wrong contact");
		}
		await this.ensureOmnichannelAssignment(roomId, room, binding);
		conversation = this.store.upsertRocketChatOmnichannelConversation({
			contextId: notification.contextId,
			source,
			providerThreadId,
			visitorToken,
			visitorId,
			contactId: binding.contactId,
			roomId,
		});
		return conversation;
	}

	async ensureOmnichannelAssignment(roomId, room, binding) {
		if (room?.servedBy?._id === binding.botUserId) return;
		const inquiryResult = await this.request("livechat/inquiries.getOne", {
			query: { roomId },
			auth: binding.credentials,
		});
		const inquiryId = inquiryResult?.inquiry?._id;
		if (!inquiryId) {
			throw new Error("Rocket.Chat Omnichannel conversation has no assignable inquiry");
		}
		await this.request("livechat/agent.status", {
			method: "POST",
			auth: binding.credentials,
			body: { status: "available" },
		});
		await this.request("livechat/inquiries.take", {
			method: "POST",
			auth: binding.credentials,
			body: {
				inquiryId,
				userId: binding.botUserId,
			},
		});
	}

	async postOmnichannelInbound(notification, binding) {
		if (notification.source !== "gmail") return null;
		const conversation = await this.ensureOmnichannelConversation(notification, binding);
		if (!conversation) return null;
		const messageId = opaqueSuffix(notification.id);
		const existing = await this.request(`livechat/message/${messageId}`, {
			query: {
				token: conversation.visitorToken,
				rid: conversation.roomId,
			},
			allowMissing: true,
		});
		if (existing?.message?._id === messageId) return messageId;
		const payload = JSON.parse(notification.payloadJson || "{}");
		const body = inboundPlainText(payload, notification.providerMessageId);
		if (!body) return null;
		const created = await this.request("livechat/message", {
			method: "POST",
			body: {
				_id: messageId,
				token: conversation.visitorToken,
				rid: conversation.roomId,
				msg: body,
			},
		});
		return rocketId(created?.message?._id, "Omnichannel message ID");
	}

	async provisionAll() {
		const results = [];
		for (const context of this.store.listContexts()) {
			results.push(await this.ensureContext(context.id, { reconcile: true }));
		}
		return results;
	}

	async postEmailLedgerNotification(notification) {
		const binding = await this.ensureContext(notification.contextId);
		await this.postOmnichannelInbound(notification, binding);
		const control = await this.ensureControlUser();
		await this.ensureRoomMember(binding.roomId, control.user);
		const history = await this.request("groups.history", {
			query: { roomId: binding.roomId, count: 100 },
			auth: control.credentials,
		});
		for (const message of history.messages ?? []) {
			if (message?.customFields?.tinyfat?.eventId === notification.id) {
				return rocketId(message._id, "message ID");
			}
		}

		const payload = JSON.parse(notification.payloadJson || "{}");
		const outbound = notification.source === "gmail_outbound";
		if (!outbound && notification.source !== "gmail") {
			throw new Error(`unsupported TINYFAT awareness source ${notification.source}`);
		}
		const sender = safeInlineCode(payload.sender) || "unknown sender";
		const recipient = safeInlineCode(outbound ? payload.recipient : payload.metadata?.to);
		const subject = safeInlineCode(payload.metadata?.subject) || "(no subject)";
		const scope = safeInlineCode(payload.route?.projectSlug) || "intake";
		const body = outbound ? ledgerBody(payload.message?.body) : inboundBody(payload, notification.providerMessageId);
			const created = await this.request("chat.postMessage", {
				method: "POST",
				auth: control.credentials,
				body: {
				roomId: binding.roomId,
				text: [
					outbound
						? `### ${this.config.notifierDisplayName} · Email sent`
						: `### ${this.config.notifierDisplayName} · Email received`,
					`**From:** \`${sender}\``,
					...(recipient ? [`**To:** \`${recipient}\``] : []),
					`**Scope:** \`${scope}\``,
					`**Subject:** \`${subject}\``,
					"",
					"**Body**",
					body,
				].join("\n"),
				customFields: {
					tinyfat: awarenessMetadata(notification, outbound),
				},
			},
		});
		return rocketId(created?.message?._id, "created message ID");
	}
}
