import assert from "node:assert/strict";
import { resolveApiKey } from "../src/model-config";

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
console.log("model-config auth reload ok");
