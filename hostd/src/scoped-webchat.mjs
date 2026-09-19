import { contextCapability, stablePrivateKey } from "./security.mjs";
import { ScopedAppAuthorizationError } from "./scoped-app-authorization.mjs";
import { resolveContextRuntimeModel } from "./runtime-model.mjs";
import { SCOPED_WEBCHAT_PROTOCOL } from "./scoped-webchat-contract.mjs";

const LEASE_RENEWAL_INTERVAL_MS = 8_000;
const IDLE_STOP_DELAY_MS = 15_000;
const STREAM_ACTIONS = new Set(["events-stream", "live", "messages"]);

export class ScopedWebchatError extends Error {
	constructor(code, status = 503) {
		super(code);
		this.name = "ScopedWebchatError";
		this.code = code;
		this.status = status;
	}
}

function deterministicUuid(hex) {
	const value = hex.slice(0, 32).split("");
	value[12] = "5";
	value[16] = "a";
	const compact = value.join("");
	return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function safeSearch(action, payload) {
	const search = new URLSearchParams();
	if (action === "events") {
		search.set("limit", String(payload.limit));
		if (payload.before !== undefined) search.set("before", String(payload.before));
	}
	if (action === "live" && payload.after !== undefined) search.set("after", String(payload.after));
	return search.size ? `?${search}` : "";
}

function runtimeRoute(action, payload) {
	const base = "/api/v2/agents/current";
	switch (action) {
		case "events": return { method: "GET", path: `${base}/events${safeSearch(action, payload)}` };
		case "events-stream": return { method: "GET", path: `${base}/events/stream` };
		case "live": return { method: "GET", path: `${base}/live${safeSearch(action, payload)}` };
		case "messages": return { method: "POST", path: `${base}/messages` };
		default: throw new ScopedWebchatError("invalid", 400);
	}
}

function nativeMessageBody(envelope, keys) {
	const input = envelope.payload;
	return JSON.stringify({
		message: input.message,
		channelId: `scoped-webchat:${keys.accountKey}`,
		source: "web",
		sourceEventType: "scoped_webchat",
		deliveryId: envelope.requestId,
		...(input.fresh_context === undefined ? {} : { fresh_context: input.fresh_context }),
		...(input.session_id === undefined ? {} : { session_id: input.session_id }),
	});
}

export class ScopedWebchat {
	constructor({
		config,
		gateway,
		store,
		runtime,
		routingKey,
		target,
		fetchImpl = fetch,
		renewalIntervalMs = LEASE_RENEWAL_INTERVAL_MS,
		idleStopDelayMs = IDLE_STOP_DELAY_MS,
	}) {
		this.config = config;
		this.gateway = gateway;
		this.store = store;
		this.runtime = runtime;
		this.routingKey = routingKey;
		this.target = target;
		this.fetchImpl = fetchImpl;
		this.renewalIntervalMs = renewalIntervalMs;
		this.idleStopDelayMs = idleStopDelayMs;
		this.connections = new Map();
		this.activeMessages = new Map();
		this.idleTimers = new Map();
		this.runtimeStarts = new Map();
		this.warmRuntimes = new Map();
	}

	hasActiveContext(contextId) {
		return (this.connections.get(contextId)?.size ?? 0) > 0 || this.activeMessages.has(contextId);
	}

	hasActiveTurn(contextId) {
		return this.activeMessages.has(contextId);
	}

	hasActiveAccount(accountKey) {
		return [...this.activeMessages.values()].some((connection) => connection.keys.accountKey === accountKey);
	}

	async authorizeRuntime(contextId) {
		const active = this.activeMessages.get(contextId);
		if (!active || active.closed || active.controller.signal.aborted) {
			throw new ScopedAppAuthorizationError();
		}
		const renewed = await this.gateway.renewScope(active.scope);
		if (
			renewed.keys.contextId !== contextId
			|| renewed.keys.accountKey !== active.keys.accountKey
			|| renewed.keys.userKey !== active.keys.userKey
			|| renewed.keys.membershipKey !== active.keys.membershipKey
		) throw new ScopedAppAuthorizationError("renewal_scope_mismatch", 403);
		active.scope = renewed.scope;
		return { ok: true, expiresAt: renewed.scope.expiresAt };
	}

	agentId(keys) {
		return deterministicUuid(stablePrivateKey(
			this.routingKey,
			"scoped-webchat-agent",
			`${this.target.id}\0${keys.accountKey}\0${keys.userKey}`,
		));
	}

	async authorize(envelope, { requireAgent = true } = {}) {
		const renewed = await this.gateway.renewScope(envelope.scope);
		const agentId = this.agentId(renewed.keys);
		if (requireAgent && envelope.agentId !== agentId) throw new ScopedWebchatError("not_found", 404);
		return { ...renewed, agentId };
	}

	async bootstrap(envelope) {
		const authorized = await this.authorize(envelope, { requireAgent: false });
		const model = resolveContextRuntimeModel(
			this.config,
			this.store,
			this.routingKey,
			this.target,
			authorized.keys.contextId,
		);
		if (
			model?.provider !== "openai"
			|| model.id !== "gpt-5.6-luna"
			|| model.thinking !== "xhigh"
		) throw new ScopedWebchatError("model_policy_unavailable", 503);
		return {
			version: SCOPED_WEBCHAT_PROTOCOL,
			agentId: authorized.agentId,
			expiresAt: authorized.scope.expiresAt,
			model: { provider: "openai", id: "gpt-5.6-luna", thinking: "xhigh", exact: true },
			capabilities: this.capabilities(),
		};
	}

	capabilities() {
		return {
			messages: true,
			awareness: true,
			cancellation: true,
			files: false,
			terminal: false,
			desktop: false,
			voice: false,
			calendar: false,
			display: false,
			embed: true,
		};
	}

	async status(envelope) {
		const authorized = await this.authorize(envelope);
		return {
			agent_id: authorized.agentId,
			mode: "hosted",
			runtime: "troublemaker",
			workspace_ready: true,
			display_mode: "terminal",
			agent_name: "Open Grants Vectors",
			capabilities: this.capabilities(),
		};
	}

	async ensureRuntime(authorized) {
		const contextId = authorized.keys.contextId;
		let runtime = this.warmRuntimes.get(contextId);
		if (runtime) {
			await this.gateway.materializeOrganizationContext(authorized.keys.accountKey);
		} else {
			let start = this.runtimeStarts.get(contextId);
			if (!start) {
				start = (async () => {
					const organization = await this.gateway.materializeOrganizationContext(authorized.keys.accountKey);
					return await this.runtime.ensureScopedOciContext(this.target, contextId, organization);
				})();
				this.runtimeStarts.set(contextId, start);
			}
			try {
				runtime = await start;
			} finally {
				if (this.runtimeStarts.get(contextId) === start) this.runtimeStarts.delete(contextId);
			}
		}
		const refreshed = await this.gateway.renewScope(authorized.scope);
		if (
			refreshed.keys.contextId !== authorized.keys.contextId
			|| refreshed.keys.accountKey !== authorized.keys.accountKey
			|| refreshed.keys.userKey !== authorized.keys.userKey
			|| refreshed.keys.membershipKey !== authorized.keys.membershipKey
		) throw new ScopedAppAuthorizationError("renewal_scope_mismatch", 403);
		authorized.scope = refreshed.scope;
		this.warmRuntimes.set(contextId, runtime);
		return runtime;
	}

	connectionSet(contextId) {
		let set = this.connections.get(contextId);
		if (!set) {
			set = new Set();
			this.connections.set(contextId, set);
		}
		return set;
	}

	trackConnection(authorized, action, runtime, controller) {
		const connection = {
			action,
			contextId: authorized.keys.contextId,
			keys: authorized.keys,
			scope: authorized.scope,
			runtime,
			controller,
			closed: false,
			timer: undefined,
		};
		this.connectionSet(connection.contextId).add(connection);
		this.startRenewal(connection);
		return connection;
	}

	startRenewal(connection) {
		const renew = async () => {
			if (connection.closed || connection.controller.signal.aborted) return;
			try {
				const renewed = await this.gateway.renewScope(connection.scope);
				if (
					renewed.keys.contextId !== connection.contextId
					|| renewed.keys.accountKey !== connection.keys.accountKey
					|| renewed.keys.userKey !== connection.keys.userKey
					|| renewed.keys.membershipKey !== connection.keys.membershipKey
				) throw new ScopedAppAuthorizationError("renewal_scope_mismatch", 403);
				connection.scope = renewed.scope;
				connection.timer = setTimeout(renew, this.renewalIntervalMs);
			} catch (error) {
				await this.revokeContext(connection.contextId, error).catch(() => undefined);
			}
		};
		connection.timer = setTimeout(renew, this.renewalIntervalMs);
	}

	async proxy(envelope, action, externalSignal) {
		if (!["events", "events-stream", "live", "messages"].includes(action)) {
			throw new ScopedWebchatError("invalid", 400);
		}
		const authorized = await this.authorize(envelope);
		if (action === "messages") {
			if (this.activeMessages.has(authorized.keys.contextId)) {
				throw new ScopedWebchatError("conflict", 409);
			}
			if (this.store.activeTurnsForContext(authorized.keys.contextId).length > 0) {
				throw new ScopedWebchatError("conflict", 409);
			}
		}
		this.cancelIdleStop(authorized.keys.contextId);
		const controller = new AbortController();
		const abort = () => controller.abort(externalSignal?.reason ?? new Error("downstream_closed"));
		const detach = () => externalSignal?.removeEventListener("abort", abort);
		if (externalSignal) {
			if (externalSignal.aborted) abort();
			else externalSignal.addEventListener("abort", abort, { once: true });
		}
		const tracked = STREAM_ACTIONS.has(action);
		const connection = tracked
			? this.trackConnection(authorized, action, undefined, controller)
			: undefined;
		if (action === "messages" && connection) this.activeMessages.set(authorized.keys.contextId, connection);
		let runtime;
		try {
			runtime = await this.ensureRuntime(authorized);
			if (controller.signal.aborted) {
				const others = [...(this.connections.get(authorized.keys.contextId) ?? [])]
					.some((candidate) => candidate !== connection && !candidate.closed && !candidate.controller.signal.aborted);
				if (!others) {
					this.warmRuntimes.delete(authorized.keys.contextId);
					await this.runtime.stopScopedOciContext(this.target, authorized.keys.contextId).catch(() => undefined);
				}
				throw controller.signal.reason ?? new Error("webchat_proxy_closed");
			}
			if (connection) connection.runtime = runtime;
			const route = runtimeRoute(action, envelope.payload);
			const upstream = await this.fetchImpl(`http://127.0.0.1:${runtime.port}${route.path}`, {
				method: route.method,
				headers: {
					authorization: `Bearer ${contextCapability(this.target.inboundToken, "web-app", authorized.keys.contextId)}`,
					accept: action === "events" ? "application/json" : "text/event-stream",
					...(action === "messages" ? { "content-type": "application/json" } : {}),
				},
				...(action === "messages" ? { body: nativeMessageBody(envelope, authorized.keys) } : {}),
				signal: controller.signal,
			});
			return {
				upstream,
				signal: controller.signal,
				close: async ({ completed = false } = {}) => {
					if (connection?.action === "messages" && !completed && !connection.closed) {
						await this.cancelRuntimeMessage(connection).catch(() => undefined);
					}
					controller.abort(new Error("webchat_proxy_closed"));
					detach();
					if (connection) await this.finishConnection(connection);
					else this.scheduleIdleStop(authorized.keys.contextId);
				},
			};
		} catch (error) {
			const runtimeFailed = runtime && !controller.signal.aborted;
			controller.abort(error);
			detach();
			if (runtimeFailed) {
				const others = [...(this.connections.get(authorized.keys.contextId) ?? [])]
					.some((candidate) => candidate !== connection && !candidate.closed && !candidate.controller.signal.aborted);
				if (!others) {
					this.warmRuntimes.delete(authorized.keys.contextId);
					await this.runtime.stopScopedOciContext(this.target, authorized.keys.contextId).catch(() => undefined);
				}
			}
			if (connection) await this.finishConnection(connection);
			else this.scheduleIdleStop(authorized.keys.contextId);
			throw error;
		}
	}

	async cancelRuntimeMessage(connection) {
		if (!connection.runtime) return;
		const response = await this.fetchImpl(
			`http://127.0.0.1:${connection.runtime.port}/api/v2/agents/current/messages/stop`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${contextCapability(this.target.inboundToken, "web-app", connection.contextId)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ channelId: `scoped-webchat:${connection.keys.accountKey}` }),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (!response.ok) throw new ScopedWebchatError("runtime_unavailable", 503);
		await response.body?.cancel().catch(() => undefined);
	}

	async stop(envelope) {
		const authorized = await this.authorize(envelope);
		const active = this.activeMessages.get(authorized.keys.contextId);
		if (!active) return { ok: true, cancelled: false };
		try {
			await this.cancelRuntimeMessage(active);
		} finally {
			active.controller.abort(new Error("user_cancelled"));
			await this.finishConnection(active);
		}
		return { ok: true, cancelled: true };
	}

	async finishConnection(connection) {
		if (connection.closed) return;
		connection.closed = true;
		if (connection.timer) clearTimeout(connection.timer);
		const set = this.connections.get(connection.contextId);
		set?.delete(connection);
		if (set?.size === 0) this.connections.delete(connection.contextId);
		if (this.activeMessages.get(connection.contextId) === connection) {
			this.activeMessages.delete(connection.contextId);
		}
		this.scheduleIdleStop(connection.contextId);
	}

	cancelIdleStop(contextId) {
		const timer = this.idleTimers.get(contextId);
		if (timer) clearTimeout(timer);
		this.idleTimers.delete(contextId);
	}

	scheduleIdleStop(contextId) {
		this.cancelIdleStop(contextId);
		if ((this.connections.get(contextId)?.size ?? 0) > 0 || this.activeMessages.has(contextId)) return;
		this.idleTimers.set(contextId, setTimeout(() => {
			this.idleTimers.delete(contextId);
			if ((this.connections.get(contextId)?.size ?? 0) > 0 || this.activeMessages.has(contextId)) return;
			this.warmRuntimes.delete(contextId);
			void this.runtime.stopScopedOciContext(this.target, contextId).catch(() => undefined);
		}, this.idleStopDelayMs));
	}

	async revokeContext(contextId, reason = new ScopedAppAuthorizationError()) {
		this.cancelIdleStop(contextId);
		const connections = [...(this.connections.get(contextId) ?? [])];
		for (const connection of connections) {
			if (connection.action === "messages") {
				await this.cancelRuntimeMessage(connection).catch(() => undefined);
			}
			connection.controller.abort(reason);
			await this.finishConnection(connection);
		}
		this.cancelIdleStop(contextId);
		this.warmRuntimes.delete(contextId);
		await this.runtime.stopScopedOciContext(this.target, contextId).catch(() => undefined);
	}

	async revokeMembership(accountKey, membershipKey, maximumVersion) {
		const contexts = new Set();
		for (const [contextId, connections] of this.connections) {
			if ([...connections].some((connection) => (
				connection.keys.accountKey === accountKey
				&& connection.keys.membershipKey === membershipKey
				&& connection.scope.membershipVersion <= maximumVersion
			))) contexts.add(contextId);
		}
		for (const contextId of contexts) await this.revokeContext(contextId);
	}

	async shutdown() {
		const idleContexts = [...this.idleTimers.keys()];
		for (const timer of this.idleTimers.values()) clearTimeout(timer);
		this.idleTimers.clear();
		for (const contextId of [...this.connections.keys()]) await this.revokeContext(contextId);
		for (const contextId of idleContexts) {
			await this.runtime.stopScopedOciContext(this.target, contextId).catch(() => undefined);
		}
		this.warmRuntimes.clear();
	}
}

export function scopedWebchatError(error) {
	if (error instanceof ScopedWebchatError) return error;
	if (error instanceof ScopedAppAuthorizationError) {
		return new ScopedWebchatError(error.status === 503 ? "unavailable" : "forbidden", error.status);
	}
	if (error?.status === 403) return new ScopedWebchatError("forbidden", 403);
	if (error?.status === 404) return new ScopedWebchatError("not_found", 404);
	if (error?.status === 409) return new ScopedWebchatError("conflict", 409);
	if (error?.status === 429) return new ScopedWebchatError("rate_limited", 429);
	return new ScopedWebchatError("unavailable", 503);
}
