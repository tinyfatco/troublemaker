import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function opaqueSuffix(contextId) {
	return createHash("sha256").update(contextId).digest("hex").slice(0, 20);
}

function mattermostId(value, label) {
	if (typeof value !== "string" || !/^[a-z0-9]{26}$/.test(value)) {
		throw new Error(`Mattermost ${label} is invalid`);
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

export class MattermostProvisioner {
	constructor(config, store, { knownEmailsByPrincipalHash = new Map() } = {}) {
		this.config = config;
		this.store = store;
		this.knownEmailsByPrincipalHash = knownEmailsByPrincipalHash;
		this.contextPromises = new Map();
		this.controlBotPromise = null;
	}

	async request(path, { method = "GET", body, allow404 = false, token = this.config.adminToken } = {}) {
		const response = await fetch(`${this.config.url}/api/v4${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(30_000),
		});
		if (allow404 && response.status === 404) return null;
		const text = await response.text();
		if (!response.ok) {
			let detail = "";
			try {
				const parsed = JSON.parse(text);
				detail = cleanMessage(parsed?.message ?? parsed?.id);
			} catch {
				detail = cleanMessage(text);
			}
			throw new Error(
				`Mattermost ${method} ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			);
		}
		if (!text) return {};
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`Mattermost ${method} ${path} returned invalid JSON`);
		}
	}

	async runtimeBinding(contextId) {
		const binding = this.store.getMattermostBinding(contextId);
		if (!binding) return null;
		const botToken = await this.readBotToken(contextId, binding.botUserId);
		if (!botToken) return null;
		return { ...binding, botToken, runtimeUrl: this.config.runtimeUrl };
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
		const channelDisplayName = verifiedContextEmail(
			this.store,
			contextId,
			this.knownEmailsByPrincipalHash,
		);
		if (!reconcile) {
			const existing = await this.runtimeBinding(contextId);
			if (existing) {
				if (channelDisplayName && existing.channelDisplayName !== channelDisplayName) {
					await this.patchChannelDisplayName(existing.channelId, channelDisplayName);
					const binding = this.store.setMattermostChannelDisplayName(contextId, channelDisplayName);
					return { ...binding, botToken: existing.botToken, runtimeUrl: this.config.runtimeUrl };
				}
				return existing;
			}
		}
		const suffix = opaqueSuffix(contextId);
		const botUsername = `operator-${suffix}`;
		const channelName = `operator-${suffix}`;
		const owner = await this.request("/users/me");
		const ownerId = mattermostId(owner?.id, "admin user ID");
		const bot = await this.ensureBot(botUsername, ownerId, {
			displayName: this.config.botDisplayName,
			description: "Private project-scoped Operator runtime",
		});
		const channel = await this.ensureChannel(channelName, channelDisplayName);

		await this.ensureTeamMember(bot.id);
		await this.ensureTeamMember(this.config.batmanUserId);
		await this.ensureChannelMember(channel.id, bot.id);
		await this.ensureChannelMember(channel.id, this.config.batmanUserId);

		const botToken = await this.ensureBotToken(contextId, bot.id);
		const binding = this.store.upsertMattermostBinding({
			contextId,
			teamId: this.config.teamId,
			channelId: channel.id,
			channelDisplayName: channel.displayName,
			botUserId: bot.id,
			botUsername,
		});
		return {
			...binding,
			botToken,
			runtimeUrl: this.config.runtimeUrl,
		};
	}

	async provisionAll() {
		const controlBot = await this.ensureControlBot();
		const results = [];
		for (const context of this.store.listContexts()) {
			const binding = await this.ensureContext(context.id, { reconcile: true });
			await this.ensureChannelMember(binding.channelId, controlBot.id);
			results.push(binding);
		}
		return results;
	}

	async ensureBot(username, ownerId, {
		displayName = this.config.botDisplayName,
		description = "Private project-scoped Operator runtime",
	} = {}) {
		let user = await this.request(`/users/username/${encodeURIComponent(username)}`, { allow404: true });
		if (!user) {
			const created = await this.request("/bots", {
				method: "POST",
				body: {
					username,
					display_name: displayName,
					description,
					owner_id: ownerId,
				},
			});
			const createdId = mattermostId(created?.user_id ?? created?.id, "created bot user ID");
			user = await this.request(`/users/${encodeURIComponent(createdId)}`);
		}
		const id = mattermostId(user?.id ?? user?.user_id, "bot user ID");
		if (user?.is_bot === false) {
			throw new Error(`Mattermost username ${username} belongs to a non-bot user`);
		}
		return { id, username };
	}

	isControlBotUser(userId) {
		return Boolean(userId && userId === this.store.getMeta("mattermost:control_bot_user_id"));
	}

	controlBotSecretPath() {
		return join(this.config.credentialsDirectory, "tinyfat-control-plane.json");
	}

	async readControlBotToken(botUserId) {
		try {
			const parsed = JSON.parse(await readFile(this.controlBotSecretPath(), "utf8"));
			if (parsed?.botUserId === botUserId && typeof parsed?.token === "string" && parsed.token) {
				return parsed.token;
			}
			return null;
		} catch (error) {
			if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
			throw error;
		}
	}

	async ensureControlBotToken(botUserId) {
		const existing = await this.readControlBotToken(botUserId);
		if (existing) return existing;
		const created = await this.request(`/users/${encodeURIComponent(botUserId)}/tokens`, {
			method: "POST",
			body: { description: "hostd TINYFAT inbound router" },
		});
		if (typeof created?.token !== "string" || !created.token) {
			throw new Error("Mattermost TINYFAT token response omitted the token");
		}
		await mkdir(this.config.credentialsDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.config.credentialsDirectory, 0o700);
		const path = this.controlBotSecretPath();
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify({ botUserId, token: created.token })}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
		return created.token;
	}

	async ensureControlBot() {
		if (this.controlBotPromise) return this.controlBotPromise;
		this.controlBotPromise = this.ensureControlBotInner();
		try {
			return await this.controlBotPromise;
		} finally {
			this.controlBotPromise = null;
		}
	}

	async ensureControlBotInner() {
		const owner = await this.request("/users/me");
		const ownerId = mattermostId(owner?.id, "admin user ID");
		const bot = await this.ensureBot(this.config.notifierUsername, ownerId, {
			displayName: this.config.notifierDisplayName,
			description: "TinyFat host-owned inbound context router",
		});
		await this.ensureTeamMember(bot.id);
		const token = await this.ensureControlBotToken(bot.id);
		this.store.setMeta("mattermost:control_bot_user_id", bot.id);
		return { ...bot, token };
	}

	async postEmailLedgerNotification(notification) {
		const binding = await this.ensureContext(notification.contextId);
		const bot = await this.ensureControlBot();
		await this.ensureChannelMember(binding.channelId, bot.id);
		const existing = await this.request(
			`/channels/${encodeURIComponent(binding.channelId)}/posts?per_page=100`,
			{ token: bot.token },
		);
		for (const post of Object.values(existing?.posts ?? {})) {
			if (
				post?.props?.tinyfat_ledger_id === notification.id
				|| post?.props?.tinyfat_inbound_id === notification.id
			) {
				return mattermostId(post.id, "post ID");
			}
		}

		const payload = JSON.parse(notification.payloadJson || "{}");
		const outbound = notification.source === "gmail_outbound";
		if (!outbound && notification.source !== "gmail") {
			throw new Error(`unsupported TINYFAT ledger source ${notification.source}`);
		}
		const sender = safeInlineCode(payload.sender) || "unknown sender";
		const recipient = safeInlineCode(outbound ? payload.recipient : payload.metadata?.to);
		const subject = safeInlineCode(payload.metadata?.subject) || "(no subject)";
		const scope = safeInlineCode(payload.route?.projectSlug) || "intake";
		const contextId = safeInlineCode(notification.contextId);
		const body = outbound ? ledgerBody(payload.message?.body) : inboundBody(payload, notification.providerMessageId);
		const created = await this.request("/posts", {
			method: "POST",
			token: bot.token,
			body: {
				channel_id: binding.channelId,
				message: [
					outbound ? "### Email sent" : "### Email received",
					`**From:** \`${sender}\``,
					...(recipient ? [`**To:** \`${recipient}\``] : []),
					`**Scope:** \`${scope}\``,
					`**Context:** \`${contextId}\``,
					`**Subject:** \`${subject}\``,
					"",
					"**Body**",
					body,
				].join("\n"),
				props: {
					tinyfat_ledger_id: notification.id,
					tinyfat_customer_channel_id: notification.contextId,
					tinyfat_sequence: notification.sequence,
					tinyfat_direction: outbound ? "outbound" : "inbound",
					...(outbound ? {} : { tinyfat_inbound_id: notification.id }),
					tinyfat_source: notification.source,
				},
			},
		});
		return mattermostId(created?.id, "created post ID");
	}

	async patchChannelDisplayName(channelId, displayName) {
		await this.request(`/channels/${encodeURIComponent(channelId)}/patch`, {
			method: "PUT",
			body: { display_name: displayName },
		});
	}

	async ensureChannel(name, desiredDisplayName) {
		let channel = await this.request(
			`/teams/${encodeURIComponent(this.config.teamId)}/channels/name/${encodeURIComponent(name)}`,
			{ allow404: true },
		);
		if (!channel) {
			channel = await this.request("/channels", {
				method: "POST",
				body: {
					team_id: this.config.teamId,
					name,
					display_name: desiredDisplayName || `Operator ${name.slice(-8)}`,
					type: "P",
					purpose: "Private Operator and observer project room",
				},
			});
		} else if (desiredDisplayName && channel.display_name !== desiredDisplayName) {
			await this.patchChannelDisplayName(channel.id, desiredDisplayName);
			channel = { ...channel, display_name: desiredDisplayName };
		}
		const id = mattermostId(channel?.id, "channel ID");
		if (channel?.type !== "P") {
			throw new Error(`Mattermost channel ${name} is not private`);
		}
		return {
			id,
			name,
			displayName: cleanMessage(channel.display_name) || desiredDisplayName || `Operator ${name.slice(-8)}`,
		};
	}

	async ensureTeamMember(userId) {
		const path = `/teams/${encodeURIComponent(this.config.teamId)}/members/${encodeURIComponent(userId)}`;
		if (await this.request(path, { allow404: true })) return;
		await this.request(`/teams/${encodeURIComponent(this.config.teamId)}/members`, {
			method: "POST",
			body: { team_id: this.config.teamId, user_id: userId },
		});
	}

	async ensureChannelMember(channelId, userId) {
		const path = `/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`;
		if (await this.request(path, { allow404: true })) return;
		await this.request(`/channels/${encodeURIComponent(channelId)}/members`, {
			method: "POST",
			body: { user_id: userId },
		});
	}

	secretPath(contextId) {
		return join(this.config.credentialsDirectory, `${opaqueSuffix(contextId)}.json`);
	}

	async readBotToken(contextId, botUserId) {
		try {
			const parsed = JSON.parse(await readFile(this.secretPath(contextId), "utf8"));
			if (parsed?.botUserId === botUserId && typeof parsed?.token === "string" && parsed.token) {
				return parsed.token;
			}
			return null;
		} catch (error) {
			if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
			throw error;
		}
	}

	async ensureBotToken(contextId, botUserId) {
		const existing = await this.readBotToken(contextId, botUserId);
		if (existing) return existing;
		const created = await this.request(`/users/${encodeURIComponent(botUserId)}/tokens`, {
			method: "POST",
			body: { description: `hostd ${opaqueSuffix(contextId)}` },
		});
		if (typeof created?.token !== "string" || !created.token) {
			throw new Error("Mattermost bot token response omitted the token");
		}
		await mkdir(this.config.credentialsDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.config.credentialsDirectory, 0o700);
		const path = this.secretPath(contextId);
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(
			temporary,
			`${JSON.stringify({ botUserId, token: created.token })}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
		return created.token;
	}
}
