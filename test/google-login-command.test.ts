import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlashCommand, resolvePendingInput } from "../src/commands.js";
import { slashCommandHandled, slashCommandPending, type PlatformAdapter } from "../src/adapters/types.js";

function waitFor(predicate: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 1000;
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error("timed out waiting for condition"));
				return;
			}
			setTimeout(tick, 0);
		};
		tick();
	});
}

function createMockPlatform(messages: string[]): PlatformAdapter {
	return {
		name: "test",
		maxMessageLength: 100_000,
		formatInstructions: "",
		start: async () => {},
		stop: async () => {},
		postMessage: async (_channel, text) => {
			messages.push(text);
			return String(messages.length);
		},
		updateMessage: async () => {},
		deleteMessage: async () => {},
		postInThread: async (_channel, _threadTs, text) => {
			messages.push(text);
			return String(messages.length);
		},
		uploadFile: async () => {},
		logToFile: () => {},
		logBotResponse: () => {},
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllUsers: () => [],
		getAllChannels: () => [],
		createContext: () => {
			throw new Error("not used");
		},
		enqueueEvent: () => false,
	};
}

const tempDir = mkdtempSync(join(tmpdir(), "google-login-command-"));
const originalGogCliPath = process.env.GOG_CLI_PATH;
const originalGogPassword = process.env.GOG_KEYRING_PASSWORD;
const originalGogBackend = process.env.GOG_KEYRING_BACKEND;

try {
	const workingDir = join(tempDir, "agent");
	const fakeGog = join(tempDir, "gog");
	const logPath = join(tempDir, "gog.log");
	writeFileSync(
		fakeGog,
		`#!/usr/bin/env bash
set -euo pipefail
if [ "\${GOG_KEYRING_BACKEND:-}" != "file" ]; then
  echo "missing file keyring backend" >&2
  exit 70
fi
if [ ! -v GOG_KEYRING_PASSWORD ]; then
  echo "missing keyring password env" >&2
  exit 71
fi
printf '%s\n' "$*" >> "${logPath}"
case "$*" in
  "--version")
    echo "gog v0.15.0"
    ;;
  "--json --no-input auth credentials list")
    echo '{"clients":[{"client":"default","default":true}]}'
    ;;
  *"auth add callie@example.com"*"--step 1"*)
    echo '{"auth_url":"https://accounts.google.com/o/oauth2/auth?state=test-state","state_reused":false}'
    ;;
  *"auth add callie@example.com"*"--step 2"* )
    if [[ "$*" != *"--auth-url http://127.0.0.1:1234/oauth2/callback?code=abc&state=xyz"* ]]; then
      echo "missing callback url" >&2
      exit 72
    fi
    echo '{"stored":true,"email":"callie@example.com","services":["calendar","contacts","docs","drive","gmail","sheets"],"client":"default"}'
    ;;
  *)
    echo "unexpected gog invocation: $*" >&2
    exit 64
    ;;
esac
`,
		"utf-8",
	);
	chmodSync(fakeGog, 0o755);
	process.env.GOG_CLI_PATH = fakeGog;
	delete process.env.GOG_KEYRING_PASSWORD;
	delete process.env.GOG_KEYRING_BACKEND;

	const messages: string[] = [];
	const platform = createMockPlatform(messages);
	const result = await handleSlashCommand("/login google", "web:default", workingDir, platform);
	assert.equal(slashCommandHandled(result), true);
	const pending = slashCommandPending(result);
	assert(pending, "google login should keep a pending flow");

	await waitFor(() => messages.some((message) => message.includes("Google Workspace login")));
	assert.equal(resolvePendingInput("web:default", "callie@example.com"), true);

	await waitFor(() => messages.some((message) => message.includes("https://accounts.google.com/o/oauth2/auth?state=test-state")));
	assert.equal(resolvePendingInput("web:default", "http://127.0.0.1:1234/oauth2/callback?code=abc&state=xyz"), true);

	await pending;
	assert(messages.some((message) => message.includes("Logged in to *Google Workspace* as callie@example.com")));

	console.log("google login command runs gog remote auth flow");
} finally {
	if (originalGogCliPath === undefined) delete process.env.GOG_CLI_PATH;
	else process.env.GOG_CLI_PATH = originalGogCliPath;
	if (originalGogPassword === undefined) delete process.env.GOG_KEYRING_PASSWORD;
	else process.env.GOG_KEYRING_PASSWORD = originalGogPassword;
	if (originalGogBackend === undefined) delete process.env.GOG_KEYRING_BACKEND;
	else process.env.GOG_KEYRING_BACKEND = originalGogBackend;
	rmSync(tempDir, { recursive: true, force: true });
}
