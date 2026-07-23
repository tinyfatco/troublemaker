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

export class MattermostProvisioner {
	constructor(config, store) {
		this.config = config;
		this.store = store;
	}

	async request(path, { method = "GET", body, allow404 = false } = {}) {
		const response = await fetch(`${this.config.url}/api/v4${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.config.adminToken}`,
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

	async ensureContext(contextId) {
		const suffix = opaqueSuffix(contextId);
		const botUsername = `manny-${suffix}`;
		const channelName = `manny-${suffix}`;
		const owner = await this.request("/users/me");
		const ownerId = mattermostId(owner?.id, "admin user ID");
		const bot = await this.ensureBot(botUsername, ownerId);
		const channel = await this.ensureChannel(channelName);

		await this.ensureTeamMember(bot.id);
		await this.ensureTeamMember(this.config.batmanUserId);
		await this.ensureChannelMember(channel.id, bot.id);
		await this.ensureChannelMember(channel.id, this.config.batmanUserId);

		const botToken = await this.ensureBotToken(contextId, bot.id);
		const binding = this.store.upsertMattermostBinding({
			contextId,
			teamId: this.config.teamId,
			channelId: channel.id,
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
		const results = [];
		for (const context of this.store.listContexts()) {
			results.push(await this.ensureContext(context.id));
		}
		return results;
	}

	async ensureBot(username, ownerId) {
		let user = await this.request(`/users/username/${encodeURIComponent(username)}`, { allow404: true });
		if (!user) {
			const created = await this.request("/bots", {
				method: "POST",
				body: {
					username,
					display_name: this.config.botDisplayName,
					description: "Private project-scoped Manny runtime",
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

	async ensureChannel(name) {
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
					display_name: `Manny ${name.slice(-8)}`,
					type: "P",
					purpose: "Private Manny and Batman project room",
				},
			});
		}
		const id = mattermostId(channel?.id, "channel ID");
		if (channel?.type !== "P") {
			throw new Error(`Mattermost channel ${name} is not private`);
		}
		return { id, name };
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
