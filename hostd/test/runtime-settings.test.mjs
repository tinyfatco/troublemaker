import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeMattermostWorkingOutput } from "../src/runtime.mjs";

const CHANNEL_ID = "cccccccccccccccccccccccccc";

test("private Manny initializes fixed Mattermost working output without overriding self configuration", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "hostd-runtime-settings-"));
	try {
		assert.equal(await initializeMattermostWorkingOutput(workspace, CHANNEL_ID), true);
		const initialized = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8"));
		assert.deepEqual(initialized.workingOutput, {
			mode: "fixed",
			target: { platform: "mattermost", channelId: CHANNEL_ID },
		});

		initialized.workingOutput = { mode: "off" };
		initialized.defaultThinkingLevel = "high";
		await writeFile(join(workspace, "settings.json"), JSON.stringify(initialized));
		assert.equal(await initializeMattermostWorkingOutput(workspace, CHANNEL_ID), false);
		const preserved = JSON.parse(await readFile(join(workspace, "settings.json"), "utf8"));
		assert.deepEqual(preserved.workingOutput, { mode: "off" });
		assert.equal(preserved.defaultThinkingLevel, "high");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
