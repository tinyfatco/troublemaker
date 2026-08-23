import { createHash } from "node:crypto";
import { contextCapability, stablePrivateKey } from "./security.mjs";

export const CLOUDFLARE_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";
export const HOSTD_OPENAI_PROVIDER = "openai";
export const HOSTD_OPENAI_MODEL = "gpt-5.6-sol";
export const HOSTD_OPENAI_THINKING = "xhigh";

export function openAiScopeIncludesContext(openAi, contextId) {
	return openAi?.scope?.mode === "all"
		|| (openAi?.scope?.mode === "contexts" && openAi.scope.contextIds.includes(contextId));
}

export function resolveContextRuntimeModel(config, store, routingKey, target, contextId) {
	if (config.openAi) {
		return openAiScopeIncludesContext(config.openAi, contextId)
			? {
				provider: HOSTD_OPENAI_PROVIDER,
				id: HOSTD_OPENAI_MODEL,
				thinking: HOSTD_OPENAI_THINKING,
				maximumOutputTokens: config.openAi.maximumOutputTokens,
			}
			: undefined;
	}
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
		.update(model.provider === CLOUDFLARE_WORKERS_AI_PROVIDER
			? `${model.provider}\0${model.id}`
			: JSON.stringify({
				provider: model.provider,
				id: model.id,
				thinking: model.thinking,
				maximumOutputTokens: model.maximumOutputTokens,
			}))
		.digest("hex")
		.slice(0, 12);
	return `:model-${digest}`;
}

export function runtimeModelEnvironment(config, target, contextId, model) {
	if (!model) return {};
	if (model.provider === HOSTD_OPENAI_PROVIDER && config.openAi) {
		if (
			model.id !== HOSTD_OPENAI_MODEL
			|| model.thinking !== HOSTD_OPENAI_THINKING
			|| model.maximumOutputTokens !== config.openAi.maximumOutputTokens
		) {
			throw new Error("Hostd OpenAI runtime model policy is inconsistent");
		}
		return {
			MOM_MODEL_PROVIDER: HOSTD_OPENAI_PROVIDER,
			MOM_MODEL_ID: HOSTD_OPENAI_MODEL,
			MOM_THINKING: HOSTD_OPENAI_THINKING,
			MOM_MAX_OUTPUT_TOKENS: String(config.openAi.maximumOutputTokens),
			TROUBLEMAKER_HOSTD_OPENAI_MIGRATED: "1",
			OPENAI_API_KEY: contextCapability(target.outboundToken, "openai", contextId),
			OPENAI_BASE_URL:
				`http://${target.hostGateway}:${config.server.port}/v1/openai/${encodeURIComponent(contextId)}`,
		};
	}
	if (model.provider === CLOUDFLARE_WORKERS_AI_PROVIDER && config.workersAi) {
		return {
			MOM_MODEL_PROVIDER: model.provider,
			MOM_MODEL_ID: model.id,
			CLOUDFLARE_API_KEY: contextCapability(target.outboundToken, "workers-ai", contextId),
			CLOUDFLARE_ACCOUNT_ID: config.workersAi.accountId,
			CLOUDFLARE_WORKERS_AI_BASE_URL:
				`http://${target.hostGateway}:${config.server.port}/v1/workers-ai/${encodeURIComponent(contextId)}`,
		};
	}
	throw new Error(`unsupported context runtime model ${model.provider}/${model.id}`);
}
