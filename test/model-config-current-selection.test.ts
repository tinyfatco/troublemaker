import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getCurrentModelSelection } from "../src/model-config.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const key of Object.keys(env)) {
		previous.set(key, process.env[key]);
		const value = env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const workingDir = mkdtempSync(join(tmpdir(), "model-config-current-selection-"));
try {
	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		defaultProvider: "openai-codex",
		defaultModel: "gpt-5.5",
	}));

	withEnv({ MOM_MODEL_PROVIDER: undefined, MOM_MODEL_ID: undefined }, () => {
		const selected = getCurrentModelSelection(workingDir);
		assert(selected.provider === "openai-codex", "settings provider is used without env override");
		assert(selected.id === "gpt-5.5", "settings model is used without env override");
	});

	withEnv({
		MOM_MODEL_PROVIDER: "openai",
		MOM_MODEL_ID: "gpt-5.6-luna",
		OPENAI_BASE_URL: "http://host.containers.internal:3099/v1/openai/synthetic-context",
		TROUBLEMAKER_HOSTD_OPENAI_MIGRATED: "1",
	}, () => {
		const selected = getCurrentModelSelection(workingDir);
		assert(selected.provider === "openai", "migrated Hostd selects the API provider");
		assert(selected.id === "gpt-5.6-luna", "migrated Hostd selects only Luna");
	});

	for (const env of [
		{
			MOM_MODEL_PROVIDER: "openai-codex",
			MOM_MODEL_ID: "gpt-5.6-luna",
			OPENAI_BASE_URL: "http://host.containers.internal:3099/v1/openai/synthetic-context",
			TROUBLEMAKER_HOSTD_OPENAI_MIGRATED: "1",
		},
		{
			MOM_MODEL_PROVIDER: "openai",
			MOM_MODEL_ID: "gpt-5.6-luna",
			OPENAI_BASE_URL: undefined,
			TROUBLEMAKER_HOSTD_OPENAI_MIGRATED: "1",
		},
	]) {
		withEnv(env, () => {
			try {
				getCurrentModelSelection(workingDir);
				assert(false, "migrated Hostd rejects personal OAuth or a missing proxy");
			} catch {
				assert(true, "migrated Hostd rejects personal OAuth or a missing proxy");
			}
		});
	}

	withEnv({ MOM_MODEL_PROVIDER: "anthropic", MOM_MODEL_ID: "claude-opus-4-6" }, () => {
		const selected = getCurrentModelSelection(workingDir);
		assert(selected.provider === "anthropic", "env provider overrides settings");
		assert(selected.id === "claude-opus-4-6", "env model overrides settings");
	});

	withEnv({ MOM_MODEL_PROVIDER: undefined, MOM_MODEL_ID: undefined }, () => {
		const selected = getCurrentModelSelection();
		assert(selected.provider === "fireworks", "default provider is used without env or settings");
		assert(selected.id === "accounts/fireworks/models/glm-5p2", "default model is used without env or settings");
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
