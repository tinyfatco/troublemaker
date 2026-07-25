import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, type AuthCredential } from "@earendil-works/pi-coding-agent";
import { persistLoginCredentialToPlatform } from "../src/commands";

const tempDir = mkdtempSync(join(tmpdir(), "login-credential-persistence-"));

try {
	const authPath = join(tempDir, "auth.json");
	writeFileSync(
		authPath,
		JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: "stale-access-token",
				refresh: "stale-refresh-token",
				expires: 4102444800000,
			},
		}, null, 2) + "\ntrailing-stale-bytes",
		"utf-8",
	);

	const authStorage = AuthStorage.create(authPath);
	const freshCredential: AuthCredential = {
		type: "oauth",
		access: "fresh-access-token",
		refresh: "fresh-refresh-token",
		expires: 4102444800000,
		accountId: "fresh-account",
	};

	// AuthStorage keeps the fresh value in memory even though initial malformed
	// JSON prevents its own file-backed persist path from repairing auth.json.
	authStorage.set("openai-codex", freshCredential);

	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	const result = await persistLoginCredentialToPlatform({
		authStorage,
		providerId: "openai-codex",
		secretKey: "codex_credentials",
		toolsToken: "fat-tools-real",
		authPath,
		fetchImpl: async (url, init) => {
			requestUrl = String(url);
			requestInit = init;
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		},
	});

	assert.equal(result.ok, true);
	assert.equal(requestUrl, "https://tinyfat.com/api/agent/secrets");
	assert.equal(requestInit?.method, "PATCH");
	assert.equal((requestInit?.headers as Record<string, string>).Authorization, "Bearer fat-tools-real");

	const authJson = JSON.parse(readFileSync(authPath, "utf-8"));
	assert.equal(authJson["openai-codex"].access, "fresh-access-token");
	assert.equal(authJson["openai-codex"].refresh, "fresh-refresh-token");
	assert.equal(authJson["openai-codex"].accountId, "fresh-account");

	const body = JSON.parse(String(requestInit?.body));
	const persisted = JSON.parse(body.codex_credentials);
	assert.equal(persisted.type, undefined);
	assert.equal(persisted.access, "fresh-access-token");
	assert.equal(persisted.refresh, "fresh-refresh-token");
	assert.equal(persisted.accountId, "fresh-account");

	const reloaded = AuthStorage.create(authPath);
	assert.equal(await reloaded.getApiKey("openai-codex"), "fresh-access-token");

	console.log("login credential persistence repairs malformed auth.json");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
