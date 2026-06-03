import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpeakTool, resolveSpeakConfig } from "../src/tools/speak.js";

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
