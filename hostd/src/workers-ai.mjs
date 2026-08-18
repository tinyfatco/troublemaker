import { createHash } from "node:crypto";
import { contextCapability, stablePrivateKey } from "./security.mjs";

export const CLOUDFLARE_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";

export class WorkersAiError extends Error {
	constructor(status, code, message = code) {
		super(message);
		this.name = "WorkersAiError";
		this.status = status;
		this.code = code;
	}
}

export function resolveContextRuntimeModel(config, store, routingKey, target, contextId) {
	if (!config.workersAi || !routingKey || !target) return undefined;
	const routes = store.listRoutesForContext(contextId, target.id);
	if (routes.length === 0 || routes.some((route) => route.source !== "phone")) return undefined;
	const principalHashes = new Set(routes.map((route) => route.principalHash));
	if (principalHashes.size !== 1) return undefined;
	const [principalHash] = principalHashes;
	const principal = config.routing.knownPhonePrincipals.find((candidate) => (
		candidate.model
		&& stablePrivateKey(routingKey, "phone-principal", candidate.phone) === principalHash
	));
	return principal?.model;
}

export function runtimeModelVersionSuffix(model) {
	if (!model) return "";
	const digest = createHash("sha256")
		.update(`${model.provider}\0${model.id}`)
		.digest("hex")
		.slice(0, 12);
	return `:model-${digest}`;
}

export function runtimeModelEnvironment(config, target, contextId, model) {
	if (!model) return {};
	if (model.provider !== CLOUDFLARE_WORKERS_AI_PROVIDER || !config.workersAi) {
		throw new Error(`unsupported context runtime model ${model.provider}/${model.id}`);
	}
	return {
		MOM_MODEL_PROVIDER: model.provider,
		MOM_MODEL_ID: model.id,
		CLOUDFLARE_API_KEY: contextCapability(target.outboundToken, "workers-ai", contextId),
		CLOUDFLARE_WORKERS_AI_BASE_URL:
			`http://${target.hostGateway}:${config.server.port}/v1/workers-ai/${encodeURIComponent(contextId)}`,
	};
}

export class HostWorkersAi {
	constructor({ config, store, routingKey, fetchImpl = globalThis.fetch }) {
		this.config = config;
		this.store = store;
		this.routingKey = routingKey;
		this.fetch = fetchImpl;
	}

	async complete(target, contextId, body, signal) {
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new WorkersAiError(400, "workers_ai_body_invalid");
		}
		const selected = resolveContextRuntimeModel(
			this.config,
			this.store,
			this.routingKey,
			target,
			contextId,
		);
		if (!selected) throw new WorkersAiError(403, "workers_ai_context_denied");
		const model = typeof body.model === "string" ? body.model.trim() : "";
		if (!model || model !== selected.id || !this.config.workersAi.allowedModels.includes(model)) {
			throw new WorkersAiError(403, "workers_ai_model_denied");
		}

		const { model: _model, ...input } = body;
		const timeoutSignal = AbortSignal.timeout(this.config.workersAi.requestTimeoutMs);
		const upstreamSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const headers = {
			authorization: `Bearer ${this.config.workersAi.apiToken}`,
			"content-type": "application/json",
			"cf-aig-collect-log-payload": "false",
			"cf-aig-max-attempts": "1",
		};
		if (this.config.workersAi.gatewayId) {
			headers["cf-aig-gateway-id"] = this.config.workersAi.gatewayId;
		}
		const endpoint = `${this.config.workersAi.apiBaseUrl}/accounts/`
			+ `${this.config.workersAi.accountId}/ai/run/${model}`;
		try {
			return await this.fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(input),
				signal: upstreamSignal,
			});
		} catch (error) {
			if (upstreamSignal.aborted) {
				throw new WorkersAiError(504, "workers_ai_timeout");
			}
			throw new WorkersAiError(
				502,
				"workers_ai_unavailable",
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}
