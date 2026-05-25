import { strict as assert } from "assert";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { findModel, resolveModel } from "../src/model-config.js";

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

function createRegistry() {
	return ModelRegistry.create(AuthStorage.create());
}

withFireworksEnv(() => {
	const registry = createRegistry();
	const selected = resolveModel(undefined, registry);
	assert.equal(selected.provider, "fireworks");
	assert.equal(selected.id, "accounts/fireworks/models/minimax-m2p7");
	assert.equal(selected.api, "anthropic-messages");
	assert.equal(selected.baseUrl, "https://tinyfat.com/api/fireworks");
});

withFireworksEnv(() => {
	const registry = createRegistry();
	const glm = findModel("glm", undefined, registry);
	assert(glm, "glm alias resolves");
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

console.log("fireworks model resolution tests passed");
