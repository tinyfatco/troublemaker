import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { contextCapability, openPrivateValue, sealPrivateValue } from "./security.mjs";

export class HostMcpError extends Error {
	constructor(code, status = 400) {
		super(code);
		this.name = "HostMcpError";
		this.code = code;
		this.status = status;
	}
}

function secret(prefix) {
	return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function digest(value) {
	return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeEqual(left, right) {
	const actual = Buffer.from(String(left || ""), "utf8");
	const expected = Buffer.from(String(right || ""), "utf8");
	return actual.length === expected.length && actual.length > 0 && timingSafeEqual(actual, expected);
}

function boundedText(value, label, maximum = 120) {
	if (typeof value !== "string") throw new HostMcpError(`${label}_required`);
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
		throw new HostMcpError(`${label}_invalid`);
	}
	return normalized;
}

export function normalizeMcpServerUrl(value) {
	const raw = boundedText(value, "server_url", 2048);
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new HostMcpError("server_url_invalid");
	}
	if (
		url.protocol !== "https:"
		|| url.username
		|| url.password
		|| url.hash
		|| !url.hostname
	) {
		throw new HostMcpError("server_url_invalid");
	}
	return url.toString();
}

function normalizeHeaderName(value) {
	const name = boundedText(value, "header_name", 80).toLowerCase();
	if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
		throw new HostMcpError("header_name_invalid");
	}
	const forbidden = new Set([
		"authorization",
		"connection",
		"content-length",
		"content-type",
		"cookie",
		"host",
		"proxy-authorization",
		"transfer-encoding",
	]);
	if (
		forbidden.has(name)
		|| name.startsWith("cf-")
		|| name.startsWith("sec-")
		|| name.startsWith("x-forwarded-")
		|| name.startsWith("x-tinyfat-")
	) {
		throw new HostMcpError("header_name_forbidden");
	}
	return name;
}

function aliasFor(displayName, id) {
	const base = displayName.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 35) || "connected-mcp";
	return `${base}-${id.replaceAll("-", "").slice(0, 8)}`;
}

function bearerToken(header) {
	const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
	return match?.[1] || "";
}

function publicInboundGrant(grant, publicBaseUrl) {
	return {
		id: grant.id,
		direction: "inbound",
		name: grant.displayName,
		status: grant.status,
		server_url: `${publicBaseUrl}/resources/${encodeURIComponent(grant.id)}`,
		created_at: grant.createdAt,
		last_used_at: grant.lastUsedAt,
	};
}

function publicOutboundConnection(connection) {
	return {
		id: connection.id,
		direction: "outbound",
		alias: connection.alias,
		name: connection.displayName,
		server_url: connection.upstreamUrl,
		auth_type: connection.authType,
		header_name: connection.headerName,
		status: connection.status,
		created_at: connection.createdAt,
		last_used_at: connection.lastUsedAt,
	};
}

export class HostMcp {
	constructor({ config, store, routingKey, runtime, onContextChanged } = {}) {
		this.config = config;
		this.store = store;
		this.routingKey = routingKey;
		this.runtime = runtime;
		this.onContextChanged = onContextChanged;
		this.contextLocks = new Map();
		this.activeInboundRequests = new Map();
	}

	async withContextLock(contextId, operation) {
		const prior = this.contextLocks.get(contextId) || Promise.resolve();
		let release;
		const current = new Promise((resolvePromise) => { release = resolvePromise; });
		const queued = prior.then(() => current);
		this.contextLocks.set(contextId, queued);
		await prior;
		try {
			return await operation();
		} finally {
			release();
			if (this.contextLocks.get(contextId) === queued) this.contextLocks.delete(contextId);
		}
	}

	createHandoff(target, contextId, input = {}) {
		if (!this.config.mcp) throw new HostMcpError("mcp_unavailable", 503);
		const context = this.store.getContext(contextId);
		if (!context || context.targetId !== target.id) throw new HostMcpError("context_not_found", 404);
		const direction = input.direction ?? "either";
		if (!["inbound", "outbound", "either"].includes(direction)) {
			throw new HostMcpError("direction_invalid");
		}
		const displayName = boundedText(input.name || "MCP connection", "name", 120);
		const upstreamUrl = input.server_url ? normalizeMcpServerUrl(input.server_url) : undefined;
		if (direction === "inbound" && upstreamUrl) throw new HostMcpError("server_url_not_allowed");
		const rawToken = secret("tfat_one_");
		const expiresAt = new Date(Date.now() + this.config.mcp.handoffTtlSeconds * 1000).toISOString();
		const handoff = this.store.createMcpHandoff({
			tokenHash: digest(rawToken),
			targetId: target.id,
			contextId,
			direction,
			displayName,
			upstreamUrl,
			allowedAuth: direction === "inbound" ? [] : ["none", "bearer", "header"],
			expiresAt,
		});
		return {
			id: handoff.id,
			url: `${this.config.mcp.handoffBaseUrl}#v=${encodeURIComponent(rawToken)}`,
			expires_at: expiresAt,
			direction,
			name: displayName,
		};
	}

	openHandoff(rawToken) {
		if (!/^tfat_one_[A-Za-z0-9_-]{43}$/.test(rawToken || "")) {
			throw new HostMcpError("handoff_unavailable", 404);
		}
		const handoff = this.store.getMcpHandoffByTokenHash(digest(rawToken), { touch: true });
		if (!handoff || handoff.status !== "pending") {
			throw new HostMcpError("handoff_unavailable", 404);
		}
		return {
			direction: handoff.direction,
			name: handoff.displayName,
			server_url: handoff.upstreamUrl,
			allowed_auth: handoff.allowedAuth,
			expires_at: handoff.expiresAt,
			agent_name: this.config.company.actor,
		};
	}

	async completeHandoff(rawToken, input = {}) {
		if (!/^tfat_one_[A-Za-z0-9_-]{43}$/.test(rawToken || "")) {
			throw new HostMcpError("handoff_unavailable", 404);
		}
		const tokenHash = digest(rawToken);
		const handoff = this.store.getMcpHandoffByTokenHash(tokenHash);
		if (!handoff || handoff.status !== "pending") {
			throw new HostMcpError("handoff_unavailable", 404);
		}
		const direction = handoff.direction === "either" ? input.direction : handoff.direction;
		if (!['inbound', 'outbound'].includes(direction)) throw new HostMcpError("direction_invalid");
		if (input.direction && handoff.direction !== "either" && input.direction !== direction) {
			throw new HostMcpError("direction_not_allowed", 403);
		}

		let response;
		if (direction === "inbound") {
			const id = `mcp_${randomBytes(18).toString("base64url")}`;
			const apiKey = secret("tfat_mcp_");
			const displayName = boundedText(input.name || handoff.displayName, "name", 120);
			this.store.completeMcpHandoff(tokenHash, {
				inboundGrant: { id, displayName, tokenHash: digest(apiKey) },
			});
			response = {
				direction,
				name: displayName,
				server_url: `${this.config.mcp.publicBaseUrl}/resources/${encodeURIComponent(id)}`,
				api_key: apiKey,
			};
		} else {
			const id = randomUUID();
			const displayName = boundedText(input.name || handoff.displayName, "name", 120);
			const upstreamUrl = normalizeMcpServerUrl(input.server_url || handoff.upstreamUrl);
			const authType = input.auth_type || "bearer";
			if (!handoff.allowedAuth.includes(authType)) throw new HostMcpError("auth_type_not_allowed", 403);
			const headerName = authType === "header" ? normalizeHeaderName(input.header_name) : undefined;
			const credential = authType === "none"
				? undefined
				: boundedText(input.secret, "secret", 8192);
			if (authType === "none" && input.secret) throw new HostMcpError("secret_not_allowed");
			const alias = aliasFor(displayName, id);
			this.store.completeMcpHandoff(tokenHash, {
				outboundConnection: {
					id,
					alias,
					displayName,
					upstreamUrl,
					authType,
					headerName,
					credentialCiphertext: credential === undefined
						? undefined
						: sealPrivateValue(this.routingKey, `mcp-upstream:${id}`, credential),
				},
			});
			response = { direction, name: displayName, alias, server_url: upstreamUrl };
		}
		try {
			await this.onContextChanged?.(handoff.contextId);
		} catch (error) {
			console.error(
				`troublemaker-hostd: MCP runtime refresh failed for ${handoff.contextId}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
		return response;
	}

	authenticateInbound(resourceId, authorization) {
		const supplied = bearerToken(authorization);
		if (!/^tfat_mcp_[A-Za-z0-9_-]{43}$/.test(supplied)) {
			throw new HostMcpError("unauthorized", 401);
		}
		const grant = this.store.getMcpInboundGrant(resourceId);
		if (!grant || grant.status !== "active" || !safeEqual(digest(supplied), grant.tokenHash)) {
			throw new HostMcpError("unauthorized", 401);
		}
		const target = this.config.targetsById.get(grant.targetId);
		const context = this.store.getContext(grant.contextId);
		if (!target || !context || context.targetId !== target.id) {
			throw new HostMcpError("unauthorized", 401);
		}
		this.store.touchMcpInboundGrant(grant.id);
		return { grant, target };
	}

	async proxyInbound({ resourceId, authorization, body, requestHeaders }) {
		const { grant, target } = this.authenticateInbound(resourceId, authorization);
		this.activeInboundRequests.set(
			grant.contextId,
			(this.activeInboundRequests.get(grant.contextId) || 0) + 1,
		);
		try {
			return await this.withContextLock(grant.contextId, async () => {
				const context = await this.runtime.ensureOciContext(target, grant.contextId);
				const headers = {
					"content-type": requestHeaders["content-type"] || "application/json",
					"accept": requestHeaders.accept || "application/json, text/event-stream",
					"x-tools-token": this.inboundRuntimeToken(target, grant.contextId),
				};
				for (const name of ["mcp-protocol-version", "mcp-session-id", "last-event-id"]) {
					if (typeof requestHeaders[name] === "string") headers[name] = requestHeaders[name];
				}
				const upstream = await fetch(`http://127.0.0.1:${context.port}/mcp`, {
					method: "POST",
					headers,
					body,
					signal: AbortSignal.timeout(180_000),
				});
				const responseBody = await upstream.arrayBuffer();
				if (responseBody.byteLength > 12 * 1024 * 1024) {
					throw new HostMcpError("mcp_runtime_response_too_large", 502);
				}
				return new Response(responseBody, {
					status: upstream.status,
					statusText: upstream.statusText,
					headers: upstream.headers,
				});
			});
		} finally {
			const remaining = (this.activeInboundRequests.get(grant.contextId) || 1) - 1;
			if (remaining > 0) this.activeInboundRequests.set(grant.contextId, remaining);
			else this.activeInboundRequests.delete(grant.contextId);
		}
	}

	isContextActive(contextId) {
		return (this.activeInboundRequests.get(contextId) || 0) > 0;
	}

	inboundRuntimeToken(target, contextId) {
		return contextCapability(target.inboundToken, "mcp-ingress", contextId);
	}

	list(contextId) {
		return {
			inbound: this.store.listMcpInboundGrants(contextId).map((grant) => (
				publicInboundGrant(grant, this.config.mcp.publicBaseUrl)
			)),
			outbound: this.store.listMcpOutboundConnections(contextId).map(publicOutboundConnection),
			handoffs: this.store.listMcpHandoffs(contextId).map((handoff) => ({
				id: handoff.id,
				direction: handoff.direction,
				name: handoff.displayName,
				status: handoff.status,
				expires_at: handoff.expiresAt,
				created_at: handoff.createdAt,
			})),
		};
	}

	async revoke(contextId, { direction, id }) {
		if (!['inbound', 'outbound'].includes(direction)) throw new HostMcpError("direction_invalid");
		const revoked = direction === "inbound"
			? this.store.revokeMcpInboundGrant(contextId, id)
			: this.store.revokeMcpOutboundConnection(contextId, id);
		if (!revoked) throw new HostMcpError("connection_not_found", 404);
		try {
			await this.onContextChanged?.(contextId);
		} catch (error) {
			console.error(
				`troublemaker-hostd: MCP runtime refresh failed for ${contextId}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
		return { ok: true, id, direction };
	}

	activeOutboundConnections(contextId) {
		return this.store.listMcpOutboundConnections(contextId, { activeOnly: true });
	}

	openOutboundCredential(connection) {
		if (!connection.credentialCiphertext) return undefined;
		return openPrivateValue(
			this.routingKey,
			`mcp-upstream:${connection.id}`,
			connection.credentialCiphertext,
		);
	}
}
