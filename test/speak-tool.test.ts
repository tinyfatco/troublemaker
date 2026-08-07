import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSpeakTool,
	resetSpeechOutputCoordinatorsForTests,
	resolveSpeakConfig,
	speechOutputLaneId,
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

async function waitForLines(path: string, expected: string[]): Promise<void> {
	const deadline = Date.now() + 3000;
	let actual = "";
	while (Date.now() < deadline) {
		actual = await readFile(path, "utf-8").catch(() => "");
		if (actual.trim().split("\n").filter(Boolean).length >= expected.length) {
			assert.deepEqual(actual.trim().split("\n").filter(Boolean), expected);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for speech trace: ${actual}`);
}

async function waitForTraceEntry(path: string, expected: string): Promise<string[]> {
	const deadline = Date.now() + 3000;
	let actual = "";
	while (Date.now() < deadline) {
		actual = await readFile(path, "utf-8").catch(() => "");
		const lines = actual.trim().split("\n").filter(Boolean);
		if (lines.includes(expected)) return lines;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${expected}: ${actual}`);
}

const tempDir = await mkdtemp(join(tmpdir(), "troublemaker-speak-test-"));
const workspaceAlias = `${tempDir}-alias`;

try {
	await symlink(tempDir, workspaceAlias);
	assert.equal(speechOutputLaneId(workspaceAlias), speechOutputLaneId(tempDir));

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
	await resetSpeechOutputCoordinatorsForTests();

	const queueTracePath = join(tempDir, "queue-trace.txt");
	const queueScriptPath = join(tempDir, "queue-speech.sh");
	await writeFile(queueScriptPath, `#!/bin/sh
text=$(cat)
printf 'start:%s\\n' "$text" >> ${shellEscape(queueTracePath)}
if [ "$text" = "interrupt-old" ]; then sleep 2; else sleep 0.15; fi
printf 'end:%s\\n' "$text" >> ${shellEscape(queueTracePath)}
`);
	await chmod(queueScriptPath, 0o700);
	await writeFile(join(tempDir, "settings.json"), `${JSON.stringify({
		speak: {
			backend: "command",
			command: `exec ${shellEscape(queueScriptPath)}`,
			maxChars: 80,
		},
	}, null, 2)}\n`);
	const queuedTool = createSpeakTool(tempDir, { env: {}, platform: "darwin" });
	await queuedTool.execute("ordered-first", { label: "first", text: "first" });
	const orderedSecond = queuedTool.execute("ordered-second", { label: "second", text: "second" });
	await orderedSecond;
	await waitForLines(queueTracePath, ["start:first", "end:first", "start:second", "end:second"]);

	const originalDuplicate = await queuedTool.execute("duplicate-id", { label: "original duplicate", text: "only-once" });
	const suppressedDuplicate = await queuedTool.execute("duplicate-id", { label: "suppressed duplicate", text: "must-not-play" });
	assert.equal(originalDuplicate.details?.duplicate, false);
	assert.equal(suppressedDuplicate.details?.duplicate, true);
	assert.match(suppressedDuplicate.content[0]?.type === "text" ? suppressedDuplicate.content[0].text : "", /duplicate.*suppressed/i);
	await waitForLines(queueTracePath, [
		"start:first", "end:first", "start:second", "end:second", "start:only-once", "end:only-once",
	]);

	await queuedTool.execute("interrupt-old-id", { label: "old active speech", text: "interrupt-old" });
	const queuedAfterInterrupt = queuedTool.execute("queued-after-id", { label: "queued after interrupt", text: "queued-after" });
	const explicitReplacement = queuedTool.execute("replacement-id", {
		label: "explicit replacement",
		text: "replacement",
		interrupt: true,
	});
	await explicitReplacement;
	await queuedAfterInterrupt;
	const interruptedTrace = await waitForTraceEntry(queueTracePath, "end:queued-after");
	assert.equal(interruptedTrace.includes("end:interrupt-old"), false, "superseded speech never completes audibly");
	assert.deepEqual(
		interruptedTrace.filter((line) => line !== "start:interrupt-old"),
		[
			"start:first", "end:first", "start:second", "end:second", "start:only-once", "end:only-once",
			"start:replacement", "end:replacement", "start:queued-after", "end:queued-after",
		],
	);
	await resetSpeechOutputCoordinatorsForTests();

	const sagPath = join(tempDir, "fake-sag.sh");
	const sagShellPath = join(tempDir, "fake-login-shell.sh");
	const sagSpokenPath = join(tempDir, "sag-spoken.txt");
	await writeFile(sagPath, `#!/bin/sh\ncat > ${shellEscape(sagSpokenPath)}\n`);
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
	assert.equal("auto" in sagConfig, false, "legacy automatic-speech state is not part of resolved configuration");
	assert.equal(sagConfig.sag.command, sagPath);
	assert.equal(sagConfig.sag.modelId, "fake-fast-model");
	await assert.rejects(readFile(sagSpokenPath, "utf-8"), /ENOENT/, "legacy auto=true does not start speech while loading settings");

	const agentSource = await readFile(new URL("../src/agent.ts", import.meta.url), "utf-8");
	assert.doesNotMatch(agentSource, /autoSpeakFinalResponse/, "final-response delivery has no automatic speech hook");

	const sagTool = createSpeakTool(tempDir, { env: {}, platform: "darwin" });
	const sagResult = await sagTool.execute("sag-speak-test", {
		label: "test explicit SAG backend",
		text: "hello from explicit SAG",
		interrupt: true,
	});
	assert.equal(sagResult.details?.backend, "sag");
	await waitForFile(sagSpokenPath, "hello from explicit SAG");

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
	await resetSpeechOutputCoordinatorsForTests();
	await rm(workspaceAlias, { recursive: true, force: true });
	await rm(tempDir, { recursive: true, force: true });
}
