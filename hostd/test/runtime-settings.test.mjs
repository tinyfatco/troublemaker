import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	initializeChannelWorkingOutput,
	initializeMattermostWorkingOutput,
	runtimeEngineRunFlags,
} from "../src/runtime.mjs";

const CHANNEL_ID = "cccccccccccccccccccccccccc";

test("private Operator initializes fixed Mattermost working output without overriding self configuration", async () => {
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

test("private customer runtime initializes fixed Rocket.Chat working output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "troublemaker-runtime-settings-"));
	try {
		assert.equal(
			await initializeChannelWorkingOutput(directory, "rocket-chat", "roomCustomer123"),
			true,
		);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")).workingOutput, {
			mode: "fixed",
			target: { platform: "rocket-chat", channelId: "roomCustomer123" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("private customer runtime initializes fixed topic-free Zulip working output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "troublemaker-runtime-settings-"));
	try {
		assert.equal(
			await initializeChannelWorkingOutput(directory, "zulip", "4"),
			true,
		);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "settings.json"), "utf8")).workingOutput, {
			mode: "fixed",
			target: { platform: "zulip", channelId: "4" },
		});
		await assert.rejects(
			initializeChannelWorkingOutput(directory, "zulip", "not-a-channel"),
			/Zulip working-output channel ID is invalid/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Zulip cutover migrates only old fixed customer-channel working output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "troublemaker-runtime-settings-"));
	try {
		const settingsPath = join(directory, "settings.json");
		await writeFile(settingsPath, JSON.stringify({
			defaultThinkingLevel: "high",
			workingOutput: {
				mode: "fixed",
				target: { platform: "mattermost", channelId: CHANNEL_ID },
			},
		}));
		assert.equal(
			await initializeChannelWorkingOutput(
				directory,
				"zulip",
				"4",
				{ migrateFromPlatforms: ["mattermost", "rocket-chat"] },
			),
			true,
		);
		const migrated = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(migrated.workingOutput, {
			mode: "fixed",
			target: { platform: "zulip", channelId: "4" },
		});
		assert.equal(migrated.defaultThinkingLevel, "high");

		migrated.workingOutput = { mode: "off" };
		await writeFile(settingsPath, JSON.stringify(migrated));
		assert.equal(
			await initializeChannelWorkingOutput(
				directory,
				"zulip",
				"5",
				{ migrateFromPlatforms: ["mattermost", "rocket-chat"] },
			),
			false,
		);
		assert.deepEqual(
			JSON.parse(await readFile(settingsPath, "utf8")).workingOutput,
			{ mode: "off" },
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("runtime engine flags keep Docker and rootless Podman launchers distinct", () => {
	assert.deepEqual(runtimeEngineRunFlags("/usr/local/bin/docker"), [
		"--add-host",
		"host.docker.internal:host-gateway",
	]);
	assert.deepEqual(runtimeEngineRunFlags("/opt/troublemaker/hostd/bin/podman-user-session"), [
		"--replace",
		"--userns=keep-id",
		"--network=slirp4netns:allow_host_loopback=true",
	]);
});
