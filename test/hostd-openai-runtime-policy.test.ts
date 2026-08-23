import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { handleSlashCommand } from "../src/commands.js";
import { resolveThinkingLevel } from "../src/core/prompt.js";
import { MomSettingsManager } from "../src/context.js";
import {
	ModelCredentialUnavailableError,
	resolveApiKey,
	resolveModel,
	resolveModelWithAuth,
} from "../src/model-config.js";
import { applyMigratedHostdStreamPolicy } from "../src/model-thinking.js";
import { applySelfConfiguration } from "../src/tools/self-configure.js";

const luna = getModel("openai" as any, "gpt-5.6-luna" as any);
assert(luna, "the pinned pi runtime must include OpenAI Luna");

const keys = [
	"MOM_MODEL_PROVIDER",
	"MOM_MODEL_ID",
	"MOM_THINKING",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"TROUBLEMAKER_HOSTD_OPENAI_MIGRATED",
] as const;
const prior = new Map(keys.map((key) => [key, process.env[key]]));
const workingDir = mkdtempSync(join(tmpdir(), "hostd-openai-runtime-policy-"));

try {
	process.env.MOM_MODEL_PROVIDER = "openai";
	process.env.MOM_MODEL_ID = "gpt-5.6-luna";
	process.env.MOM_THINKING = "max";
	process.env.OPENAI_BASE_URL = "http://host.containers.internal:3099/v1/openai/synthetic-context";
	process.env.TROUBLEMAKER_HOSTD_OPENAI_MIGRATED = "1";

	const unavailableRegistry = {
		getAll: () => [luna],
		hasConfiguredAuth: () => false,
	};
	assert.throws(
		() => resolveModelWithAuth(workingDir, unavailableRegistry as any),
		(error: unknown) => error instanceof ModelCredentialUnavailableError
			&& error.provider === "openai",
		"a missing proxy capability must not fall back to another provider",
	);
	process.env.OPENAI_API_KEY = "synthetic-context-capability";
	const proxiedLuna = resolveModelWithAuth(workingDir, unavailableRegistry as any);
	assert.equal(proxiedLuna.provider, "openai");
	assert.equal(proxiedLuna.id, "gpt-5.6-luna");
	assert.equal(
		proxiedLuna.baseUrl,
		process.env.OPENAI_BASE_URL,
		"the injected context capability satisfies migrated authentication through the proxy",
	);
	assert.equal(
		await resolveApiKey({
			refresh: () => { throw new Error("stored authentication must not be consulted"); },
		} as any, "openai"),
		"synthetic-context-capability",
		"migrated requests use only the injected context capability",
	);
	const loginMessages: string[] = [];
	const loginResult = await handleSlashCommand(
		"/login openai-codex",
		"web:synthetic",
		workingDir,
		{ postMessage: async (_channel: string, message: string) => {
			loginMessages.push(message);
			return "synthetic-message";
		} } as any,
	);
	assert.equal(loginResult, true);
	assert.match(loginMessages[0], /subscription login is disabled/);
	assert.throws(
		() => resolveModel(workingDir, { getAll: () => [] } as any),
		/Required migrated Hostd model not found/,
		"a missing pinned model must not fall back to another model",
	);
	assert.deepEqual(
		applyMigratedHostdStreamPolicy({ reasoning: "max", maxTokens: 1024 }),
		{ reasoning: "max", maxTokens: 1024, maxRetries: 0 },
		"migrated calls disable provider retries",
	);
	assert.deepEqual(
		new MomSettingsManager(workingDir).getRetrySettings(),
		{ enabled: false, maxRetries: 0, baseDelayMs: 2000 },
		"migrated sessions disable whole-turn and compaction retries",
	);
	assert.equal(
		resolveThinkingLevel({ readText: () => '{"thinking_level":"low"}' } as any),
		"max",
		"the Hostd max lock overrides workspace settings",
	);
	assert.throws(
		() => applySelfConfiguration(workingDir, "model", "fireworks/glm"),
		/model is locked by the service environment/,
	);
	assert.throws(
		() => applySelfConfiguration(workingDir, "thinking_level", "high"),
		/thinking_level is locked by the service environment/,
	);

	process.env.MOM_THINKING = "high";
	assert.throws(
		() => resolveThinkingLevel({ readText: () => undefined } as any),
		/require MOM_THINKING=max/,
		"a migrated context cannot lower the max-thinking lock",
	);
} finally {
	for (const [key, value] of prior) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("Hostd OpenAI runtime policy tests passed");
