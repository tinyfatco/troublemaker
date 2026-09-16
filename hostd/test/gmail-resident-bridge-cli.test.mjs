import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGmailResidentBridgeConfig } from "../src/gmail-resident-bridge-cli.mjs";

function validConfig(directory, overrides = {}) {
	return {
		listenHost: "127.0.0.1",
		listenPort: 13120,
		headscaleNodeId: 14,
		runtimeIdentity: "runtime-identity",
		account: "agent@example.com",
		contextId: "personal-vm",
		gogPath: "/usr/local/bin/gog",
		statePath: join(directory, "state.json"),
		identityTokenFile: join(directory, "identity-token"),
		inboundTokenFile: join(directory, "inbound-token"),
		hostdIngressTokenFile: join(directory, "hostd-ingress-token"),
		runtimeTokenFile: join(directory, "runtime-token"),
		hostdIngressUrl: "http://127.0.0.1:19444/v1/inbound/gmail-history",
		runtimeUrl: "http://127.0.0.1:3018/email/inbound",
		activeIntervalMs: 2000,
		...overrides,
	};
}

function writeConfig(directory, config, mode = 0o600) {
	const path = join(directory, `config-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(path, JSON.stringify(config), { mode });
	chmodSync(path, mode);
	return path;
}

test("resident bridge config is guest-loopback-only and preserves exact runtime identity pins", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-resident-config-"));
	try {
		const loaded = await loadGmailResidentBridgeConfig(writeConfig(directory, validConfig(directory)));
		assert.equal(loaded.listenHost, "127.0.0.1");
		assert.equal(loaded.runtimeUrl, "http://127.0.0.1:3018/email/inbound");
		assert.equal(loaded.headscaleNodeId, 14);
		assert.equal(loaded.runtimeIdentity, "runtime-identity");
		await assert.rejects(
			loadGmailResidentBridgeConfig(writeConfig(directory, validConfig(directory, { listenHost: "0.0.0.0" }))),
			/loopback only/,
		);
		await assert.rejects(
			loadGmailResidentBridgeConfig(writeConfig(directory, validConfig(directory, { runtimeUrl: "http://192.0.2.1:3018/email/inbound" }))),
			/runtime URL must use guest loopback/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("resident bridge refuses a group-readable configuration file", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-resident-config-mode-"));
	try {
		await assert.rejects(
			loadGmailResidentBridgeConfig(writeConfig(directory, validConfig(directory), 0o640)),
			/must not be group\/world accessible/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
