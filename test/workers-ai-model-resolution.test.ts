import { strict as assert } from "node:assert";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveModelWithAuth } from "../src/model-config.js";

const original = {
	key: process.env.CLOUDFLARE_API_KEY,
	baseUrl: process.env.CLOUDFLARE_WORKERS_AI_BASE_URL,
	provider: process.env.MOM_MODEL_PROVIDER,
	model: process.env.MOM_MODEL_ID,
};

process.env.CLOUDFLARE_API_KEY = "test-context-capability";
process.env.CLOUDFLARE_WORKERS_AI_BASE_URL = "http://host.test/v1/workers-ai/test-context";
process.env.MOM_MODEL_PROVIDER = "cloudflare-workers-ai";
process.env.MOM_MODEL_ID = "@cf/zai-org/glm-5.2";

try {
	const registry = ModelRegistry.create(AuthStorage.create());
	const model = resolveModelWithAuth(undefined, registry);
	assert.equal(model.provider, "cloudflare-workers-ai");
	assert.equal(model.id, "@cf/zai-org/glm-5.2");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "http://host.test/v1/workers-ai/test-context");
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 262_144);
	assert.equal(model.cost.input, 1.4);
	assert.equal(model.cost.output, 4.4);
	assert.equal(model.cost.cacheRead, 0.26);
} finally {
	for (const [key, value] of [
		["CLOUDFLARE_API_KEY", original.key],
		["CLOUDFLARE_WORKERS_AI_BASE_URL", original.baseUrl],
		["MOM_MODEL_PROVIDER", original.provider],
		["MOM_MODEL_ID", original.model],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

console.log("Workers AI model resolution tests passed");
