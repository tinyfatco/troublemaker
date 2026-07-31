import assert from "node:assert/strict";
import {
	ModelCredentialUnavailableError,
	resolveApiKey,
} from "../src/model-config";

const calls: string[] = [];
const authStorage = {
	reload() {
		calls.push("reload");
	},
	async getApiKey(provider: string) {
		calls.push(`getApiKey:${provider}`);
		return "token";
	},
};

const key = await resolveApiKey(authStorage as any, "openai-codex");

assert.equal(key, "token");
assert.deepEqual(calls, ["reload", "getApiKey:openai-codex"]);

await assert.rejects(
	resolveApiKey({
		reload() {},
		async getApiKey() { return undefined; },
	} as any, "example-provider"),
	(error: unknown) => error instanceof ModelCredentialUnavailableError
		&& error.code === "MODEL_CREDENTIAL_UNAVAILABLE"
		&& error.provider === "example-provider",
);

console.log("model-config auth reload ok");
