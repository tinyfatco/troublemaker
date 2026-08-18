import { createHash } from "node:crypto";

function cleanInline(value) {
	return typeof value === "string"
		? value.replaceAll(/[\u0000-\u001f\u007f]/g, " ").replaceAll("@", "＠").trim().slice(0, 500)
		: "";
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
	const bounded = cleaned.length > 10_000
		? `${cleaned.slice(0, 10_000)}\n\n[Body truncated by TINYFAT]`
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

function principalLabel(email, contextId, storedLabel, configuredLabel) {
	const configured = cleanInline(storedLabel) || cleanInline(configuredLabel);
	if (configured) return configured;
	const local = email?.split("@", 1)[0] || `Customer ${contextId.slice(-8)}`;
	const words = local.split(/[._+-]+/).filter(Boolean);
	return words.map((word) => `${word[0]?.toUpperCase() || ""}${word.slice(1)}`).join(" ") || "Customer";
}

function bindingMarker(contextId) {
	return createHash("sha256").update(contextId, "utf8").digest("hex").slice(0, 16);
}

function channelDescription(contextId) {
	return [
		"Private customer exchange feed backed by one isolated agent runtime.",
		`Hostd binding: ${bindingMarker(contextId)}`,
	].join("\n");
}

function ownedByContext(stream, contextId) {
	return String(stream?.description || "").includes(`Hostd binding: ${bindingMarker(contextId)}`);
}

function isChannelNameConflict(error) {
	return error instanceof Error
		&& /Zulip POST channels\/create returned HTTP (?:400|409): .*already exists/i.test(
			error.message,
		);
}

function positiveInteger(value, label) {
	const candidate = Number(value);
	if (!Number.isInteger(candidate) || candidate <= 0) {
		throw new Error(`Zulip ${label} is invalid`);
	}
	return candidate;
}

function zulipForm(parameters) {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(parameters)) {
		if (value === undefined) continue;
		body.set(key, typeof value === "string" ? value : JSON.stringify(value));
	}
	return body;
}

export class ZulipProvisioner {
	constructor(config, store, {
		knownEmailsByPrincipalHash = new Map(),
		knownLabelsByPrincipalHash = new Map(),
	} = {}) {
		this.config = config;
		this.store = store;
		this.knownEmailsByPrincipalHash = knownEmailsByPrincipalHash;
		this.knownLabelsByPrincipalHash = knownLabelsByPrincipalHash;
		this.contextPromises = new Map();
		this.identityPromise = null;
	}

	auth(kind = "administrator") {
		if (kind === "agent") {
			return { email: this.config.agentEmail, apiKey: this.config.agentApiKey };
		}
		if (kind === "projector") {
			return { email: this.config.projectorEmail, apiKey: this.config.projectorApiKey };
		}
		return {
			email: this.config.administratorEmail,
			apiKey: this.config.administratorApiKey,
		};
	}

	async request(path, {
		method = "GET",
		query,
		form,
		auth = "administrator",
		allowMissing = false,
	} = {}) {
		const url = new URL(`${this.config.url}/api/v1/${path.replace(/^\/+/, "")}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) {
				url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
			}
		}
		const credentials = typeof auth === "string" ? this.auth(auth) : auth;
		const response = await fetch(url, {
			method,
			headers: {
				authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.apiKey}`).toString("base64")}`,
			},
			...(form === undefined ? {} : { body: form instanceof URLSearchParams ? form : zulipForm(form) }),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		let payload = {};
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`Zulip ${method} ${path} returned invalid JSON`);
		}
		if (allowMissing && response.status === 404) return null;
		if (!response.ok || payload?.result === "error") {
			const detail = cleanInline(payload?.msg);
			throw new Error(
				`Zulip ${method} ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			);
		}
		return payload;
	}

	async identities() {
		if (this.identityPromise) return this.identityPromise;
		this.identityPromise = (async () => {
			const [result, authenticated] = await Promise.all([
				this.request("users"),
				this.request("users/me"),
			]);
			const byEmail = new Map(
				(result.members ?? []).map((user) => [String(user.email).toLowerCase(), user]),
			);
			const requireUser = (email, role) => {
				const user = byEmail.get(email);
				if (!user) throw new Error(`Zulip ${role} identity ${email} is missing`);
				return {
					...user,
					user_id: positiveInteger(user.user_id, `${role} user ID`),
				};
			};
			const administrator = {
				...authenticated,
				user_id: positiveInteger(authenticated.user_id, "administrator user ID"),
			};
			const agent = requireUser(this.config.agentEmail, "agent");
			const projector = requireUser(this.config.projectorEmail, "projector");
			if (administrator.is_bot || (!administrator.is_admin && !administrator.is_owner)) {
				throw new Error("Zulip authenticated administrator must be a human realm administrator");
			}
			if (!agent.is_bot || !projector.is_bot) {
				throw new Error("Zulip agent and projector identities must be bots");
			}
			const members = this.config.memberEmails.map((email) => requireUser(email, "member"));
			const observers = this.config.observerEmails.map((email) => requireUser(email, "observer"));
			return { administrator, agent, projector, members, observers };
		})();
		try {
			return await this.identityPromise;
		} catch (error) {
			this.identityPromise = null;
			throw error;
		}
	}

	async listChannels() {
		const result = await this.request("streams", {
			query: {
				include_public: true,
				include_subscribed: true,
				include_all_active: true,
			},
		});
		return result.streams ?? [];
	}

	desiredSubscriberIds(identities) {
		return [...new Set([
			identities.administrator.user_id,
			identities.agent.user_id,
			identities.projector.user_id,
			...identities.members.map((user) => user.user_id),
			...identities.observers.map((user) => user.user_id),
		])];
	}

	async ensureSubscribers(channelName, identities) {
		await this.request("users/me/subscriptions", {
			method: "POST",
			form: zulipForm({
				subscriptions: [{ name: channelName }],
				principals: this.desiredSubscriberIds(identities),
				authorization_errors_fatal: true,
			}),
		});
	}

	channelName(contextId) {
		const email = verifiedContextEmail(
			this.store,
			contextId,
			this.knownEmailsByPrincipalHash,
		);
		const principalHash = contextId.split(":")[1];
		const storedLabel = this.store.getPrincipal?.(principalHash)?.displayLabel;
		return `customer · ${principalLabel(
			email,
			contextId,
			storedLabel,
			this.knownLabelsByPrincipalHash.get(principalHash),
		)}`;
	}

	freshChannel(streams, contextId, baseName, unavailableNames = new Set()) {
		const marker = bindingMarker(contextId);
		const candidates = [
			baseName,
			`${baseName} · ${marker.slice(0, 8)}`,
			`${baseName} · ${marker}`,
		];
		for (const name of candidates) {
			const existing = streams.find((candidate) => candidate.name === name);
			if (existing && ownedByContext(existing, contextId)) {
				return { name, stream: existing };
			}
			if (!existing && !unavailableNames.has(name)) return { name, stream: existing };
		}
		throw new Error(`Zulip channel namespace is exhausted for ${baseName}`);
	}

	async runtimeBinding(contextId) {
		const binding = this.store.getZulipBinding(contextId);
		if (!binding) return null;
		const stream = (await this.listChannels())
			.find((candidate) => Number(candidate.stream_id) === Number(binding.channelId));
		if (!stream) return null;
		return { ...binding, platform: "zulip" };
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
		const identities = await this.identities();
		const baseName = this.channelName(contextId);
		const existing = this.store.getZulipBinding(contextId);
		let streams = await this.listChannels();
		let stream = existing
			? streams.find((candidate) => Number(candidate.stream_id) === Number(existing.channelId))
			: null;
		const fresh = stream ? null : this.freshChannel(streams, contextId, baseName);
		let desiredName = stream ? existing.channelName : fresh.name;
		if (!stream) stream = fresh.stream;

		if (!stream) {
			const unavailableNames = new Set();
			while (!stream) {
				try {
					await this.request("channels/create", {
						method: "POST",
						form: zulipForm({
							name: desiredName,
							description: channelDescription(contextId),
							subscribers: this.desiredSubscriberIds(identities),
							invite_only: true,
							history_public_to_subscribers: false,
							announce: false,
							// Unlike the stream update route, channel creation parses
							// this enum through Zulip's JSON request convention.
							topics_policy: JSON.stringify("empty_topic_only"),
						}),
					});
				} catch (error) {
					if (!isChannelNameConflict(error)) throw error;
					unavailableNames.add(desiredName);
					streams = await this.listChannels();
					const retry = this.freshChannel(
						streams,
						contextId,
						baseName,
						unavailableNames,
					);
					desiredName = retry.name;
					stream = retry.stream;
					continue;
				}
				streams = await this.listChannels();
				stream = streams.find((candidate) => candidate.name === desiredName);
				break;
			}
		}
		if (!stream) throw new Error(`Zulip did not return customer channel ${desiredName}`);
		if (fresh && !ownedByContext(stream, contextId)) {
			throw new Error(`Zulip returned an unrelated customer channel named ${desiredName}`);
		}

		const channelId = positiveInteger(stream.stream_id, "channel ID");
		if (
			reconcile
			|| stream.name !== desiredName
			|| stream.topics_policy !== "empty_topic_only"
		) {
			await this.request(`streams/${channelId}`, {
				method: "PATCH",
				form: zulipForm({
					...(stream.name === desiredName ? {} : { new_name: desiredName }),
					description: channelDescription(contextId),
					topics_policy: "empty_topic_only",
				}),
			});
		}
		await this.ensureSubscribers(desiredName, identities);
		const binding = this.store.upsertZulipBinding({
			contextId,
			channelId,
			channelName: desiredName,
			agentUserId: identities.agent.user_id,
			projectorUserId: identities.projector.user_id,
		});
		return { ...binding, platform: "zulip" };
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
		const payload = JSON.parse(notification.payloadJson || "{}");
		if (notification.source === "web_chat") {
			const sender = cleanInline(payload.sender) || "Website visitor";
			const body = ledgerBody(payload.message?.body);
			const created = await this.request("messages", {
				method: "POST",
				auth: "projector",
				form: zulipForm({
					type: "channel",
					to: binding.channelId,
					topic: "",
					content: [
						"**Website chat received**",
						`**From:** ${sender}`,
						"",
						body,
					].join("\n"),
				}),
			});
			return String(positiveInteger(created.id, "message ID"));
		}
		const phoneOutbound = notification.source === "phone_outbound";
		if (phoneOutbound || notification.source === "phone") {
			const sender = cleanInline(payload.sender) || "unknown sender";
			const recipient = cleanInline(payload.recipient);
			const body = ledgerBody(payload.message?.body);
			const created = await this.request("messages", {
				method: "POST",
				auth: "projector",
				form: zulipForm({
					type: "channel",
					to: binding.channelId,
					topic: "",
					content: [
						phoneOutbound ? "**SMS sent**" : "**SMS received**",
						`**From:** ${sender}`,
						...(recipient ? [`**To:** ${recipient}`] : []),
						"",
						body,
					].join("\n"),
				}),
			});
			return String(positiveInteger(created.id, "message ID"));
		}
		const outbound = notification.source === "gmail_outbound";
		if (!outbound && notification.source !== "gmail") {
			throw new Error(`unsupported TINYFAT awareness source ${notification.source}`);
		}
		const sender = cleanInline(payload.sender) || "unknown sender";
		const recipient = cleanInline(outbound ? payload.recipient : payload.metadata?.to);
		const subject = cleanInline(payload.metadata?.subject) || "(no subject)";
		const body = outbound
			? ledgerBody(payload.message?.body)
			: inboundBody(payload, notification.providerMessageId);
		const created = await this.request("messages", {
			method: "POST",
			auth: "projector",
			form: zulipForm({
				type: "channel",
				to: binding.channelId,
				topic: "",
				content: [
					outbound ? "**Email sent**" : "**Email received**",
					`**From:** ${sender}`,
					...(recipient ? [`**To:** ${recipient}`] : []),
					`**Subject:** ${subject}`,
					"",
					body,
				].join("\n"),
			}),
		});
		return String(positiveInteger(created.id, "message ID"));
	}
}
