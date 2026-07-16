import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	autoSpeakFinalResponse,
	createSpeakTool,
	prepareAutomaticSpeechText,
	resolveSpeakConfig,
} from "../src/tools/speak.js";

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

async function waitForFile(path: string, expected: string): Promise<void> {
	const deadline = Date.now() + 2000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const actual = await readFile(path, "utf-8");
			if (actual === expected) return;
			lastError = new Error(`Unexpected file content: ${actual}`);
		} catch (err) {
			lastError = err;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw lastError instanceof Error ? lastError : new Error("Timed out waiting for file");
}

const tempDir = await mkdtemp(join(tmpdir(), "troublemaker-speak-test-"));

try {
	const spokenPath = join(tempDir, "spoken.txt");
	await writeFile(join(tempDir, "settings.json"), `${JSON.stringify({
		speak: {
			backend: "command",
			command: `cat > ${shellEscape(spokenPath)}`,
			maxChars: 80,
		},
	}, null, 2)}\n`);

	const commandConfig = resolveSpeakConfig(tempDir, { env: {}, platform: "darwin" });
	assert.equal(commandConfig.backend, "command");
	assert.equal(commandConfig.enabled, true);
	assert.equal(commandConfig.maxChars, 80);

	const tool = createSpeakTool(tempDir, { env: {}, platform: "darwin" });
	const result = await tool.execute("speak-test", {
		label: "test command backend",
		text: "hello from speak",
		interrupt: true,
	});
	assert.equal(result.details?.backend, "command");
	await waitForFile(spokenPath, "hello from speak");

	const sagPath = join(tempDir, "fake-sag.sh");
	const sagShellPath = join(tempDir, "fake-login-shell.sh");
	const autoSpokenPath = join(tempDir, "auto-spoken.txt");
	await writeFile(sagPath, `#!/bin/sh\ncat > ${shellEscape(autoSpokenPath)}\n`);
	await writeFile(sagShellPath, "#!/bin/sh\nfor last do :; done\nexec /bin/sh -c \"$last\"\n");
	await chmod(sagPath, 0o700);
	await chmod(sagShellPath, 0o700);
	await writeFile(join(tempDir, "settings.json"), `${JSON.stringify({
		speak: {
			enabled: true,
			auto: true,
			backend: "sag",
			maxChars: 80,
			sag: {
				command: sagPath,
				modelId: "fake-fast-model",
				shell: sagShellPath,
			},
		},
	}, null, 2)}\n`);

	const sagConfig = resolveSpeakConfig(tempDir, { env: {}, platform: "darwin" });
	assert.equal(sagConfig.backend, "sag");
	assert.equal(sagConfig.auto, true);
	assert.equal(sagConfig.sag.command, sagPath);
	assert.equal(sagConfig.sag.modelId, "fake-fast-model");
	assert.equal(prepareAutomaticSpeechText("**Hello** [Alex](https://example.com).", 80), "Hello Alex.");
	assert.equal(await autoSpeakFinalResponse(tempDir, "**Hello** [Alex](https://example.com).", { env: {}, platform: "darwin" }), true);
	await waitForFile(autoSpokenPath, "Hello Alex.");

	const httpConfig = resolveSpeakConfig(tempDir, {
		env: {
			MOM_SPEAK_BACKEND: "http",
			MOM_SPEAK_URL: "http://127.0.0.1:32123/speak",
			MOM_SPEAK_TOKEN: "bridge-token",
			MOM_SPEAK_TOKEN_HEADER: "x-openclicky-token",
			MOM_SPEAK_TOKEN_PREFIX: "",
		},
		platform: "linux",
	});
	assert.equal(httpConfig.backend, "http");
	assert.equal(httpConfig.http?.url, "http://127.0.0.1:32123/speak");
	assert.equal(httpConfig.http?.headers["x-openclicky-token"], "bridge-token");

	const disabledConfig = resolveSpeakConfig(tempDir, {
		env: { MOM_SPEAK_ENABLED: "false" },
		platform: "darwin",
	});
	assert.equal(disabledConfig.enabled, false);
} finally {
	await rm(tempDir, { recursive: true, force: true });
}
