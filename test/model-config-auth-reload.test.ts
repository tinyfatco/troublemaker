import assert from "node:assert/strict";
import {
	ModelCredentialUnavailableError,
	resolveApiKey,
} from "../src/model-config";

const calls: string[] = [];
const modelRegistry = {
	async refresh() {
		calls.push("reload");
	},
	async getApiKeyForProvider(provider: string) {
		calls.push(`getApiKey:${provider}`);
		return "token";
	},
};

const key = await resolveApiKey(modelRegistry as any, "openai-codex");

assert.equal(key, "token");
assert.deepEqual(calls, ["reload", "getApiKey:openai-codex"]);

await assert.rejects(
	resolveApiKey({
		async refresh() {},
		async getApiKeyForProvider() { return undefined; },
	} as any, "example-provider"),
	(error: unknown) => error instanceof ModelCredentialUnavailableError
		&& error.code === "MODEL_CREDENTIAL_UNAVAILABLE"
		&& error.provider === "example-provider",
);

console.log("model-config auth reload ok");
