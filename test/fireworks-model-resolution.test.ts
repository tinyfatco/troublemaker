import { strict as assert } from "assert";
import { getModels } from "@earendil-works/pi-ai/compat";
import { findModel, resolveModel, resolveModelWithAuth } from "../src/model-config.js";

function withFireworksEnv(fn: () => void) {
	const originalKey = process.env.FIREWORKS_API_KEY;
	const originalBaseUrl = process.env.FIREWORKS_BASE_URL;
	const originalProvider = process.env.MOM_MODEL_PROVIDER;
	const originalModel = process.env.MOM_MODEL_ID;

	process.env.FIREWORKS_API_KEY = "test-fireworks-key";
	process.env.FIREWORKS_BASE_URL = "https://tinyfat.com/api/fireworks";
	delete process.env.MOM_MODEL_PROVIDER;
	delete process.env.MOM_MODEL_ID;

	try {
		fn();
	} finally {
		if (originalKey === undefined) delete process.env.FIREWORKS_API_KEY;
		else process.env.FIREWORKS_API_KEY = originalKey;
		if (originalBaseUrl === undefined) delete process.env.FIREWORKS_BASE_URL;
		else process.env.FIREWORKS_BASE_URL = originalBaseUrl;
		if (originalProvider === undefined) delete process.env.MOM_MODEL_PROVIDER;
		else process.env.MOM_MODEL_PROVIDER = originalProvider;
		if (originalModel === undefined) delete process.env.MOM_MODEL_ID;
		else process.env.MOM_MODEL_ID = originalModel;
	}
}

function createRegistry(configuredProviders = new Set(["fireworks", "openai-codex"])) {
	return {
		getAll: () => [...getModels("openai-codex"), ...getModels("fireworks")],
		getAvailable: () => [],
		hasConfiguredAuth: (model: { provider: string }) => configuredProviders.has(model.provider),
	} as any;
}

withFireworksEnv(() => {
	const registry = createRegistry();
	const selected = resolveModel(undefined, registry);
	assert.equal(selected.provider, "fireworks");
	assert.equal(selected.id, "accounts/fireworks/models/glm-5p2");
	assert.equal(selected.api, "anthropic-messages");
	assert.equal(selected.baseUrl, "https://tinyfat.com/api/fireworks");
	assert.equal(selected.contextWindow, 1048576);
	assert.equal(selected.cost.input, 1.4);
	assert.equal(selected.cost.output, 4.4);
	assert.equal(selected.cost.cacheRead, 0.26);
});

withFireworksEnv(() => {
	const registry = createRegistry();
	const glm = findModel("glm", undefined, registry);
	assert(glm, "glm alias resolves");
	assert.equal(glm.provider, "fireworks");
	assert.equal(glm.id, "accounts/fireworks/models/glm-5p2");
	assert.equal(glm.api, "anthropic-messages");
});

withFireworksEnv(() => {
	const registry = createRegistry();
	const glm = findModel("glm-5.1", undefined, registry);
	assert(glm, "glm-5.1 alias resolves");
	assert.equal(glm.provider, "fireworks");
	assert.equal(glm.id, "accounts/fireworks/models/glm-5p1");
	assert.equal(glm.api, "anthropic-messages");
});

withFireworksEnv(() => {
	const registry = createRegistry();
	const deepseek = findModel("deepseek", undefined, registry);
	assert(deepseek, "deepseek alias resolves");
	assert.equal(deepseek.id, "accounts/fireworks/models/deepseek-v4-pro");
	assert.equal(deepseek.api, "anthropic-messages");
});

withFireworksEnv(() => {
	const registry = createRegistry();
	assert.equal(findModel("deepseek-v3", undefined, registry), undefined);
});

withFireworksEnv(() => {
	const originalProvider = process.env.MOM_MODEL_PROVIDER;
	const originalModel = process.env.MOM_MODEL_ID;
	process.env.MOM_MODEL_PROVIDER = "openai-codex";
	process.env.MOM_MODEL_ID = "gpt-5.5";

	try {
		const registry = createRegistry(new Set(["fireworks"]));
		const selected = resolveModelWithAuth(undefined, registry);
		assert.equal(selected.provider, "fireworks");
		assert.equal(selected.id, "accounts/fireworks/models/glm-5p2");
	} finally {
		if (originalProvider === undefined) delete process.env.MOM_MODEL_PROVIDER;
		else process.env.MOM_MODEL_PROVIDER = originalProvider;
		if (originalModel === undefined) delete process.env.MOM_MODEL_ID;
		else process.env.MOM_MODEL_ID = originalModel;
	}
});

console.log("fireworks model resolution tests passed");
