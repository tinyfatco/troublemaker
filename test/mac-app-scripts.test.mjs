import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const buildScriptPath = "scripts/build-mac-app.sh";
const runScriptPath = "scripts/run-dev.sh";
const localRunScriptPath = "scripts/run-local-mac.sh";
const packageDriverScriptPath = "scripts/package-mac-cua-driver.mjs";
const buildScript = readFileSync(buildScriptPath, "utf8");
const runScript = readFileSync(runScriptPath, "utf8");
const localRunScript = readFileSync(localRunScriptPath, "utf8");
const packageDriverScript = readFileSync(packageDriverScriptPath, "utf8");

test("Mac app scripts are valid Bash", () => {
	for (const scriptPath of [buildScriptPath, runScriptPath, localRunScriptPath]) {
		const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
});

test("packaged computer backend is pinned, self-contained, and rollback-safe", () => {
	assert.match(buildScript, /TROUBLEMAKER_CUA_DRIVER_SOURCE/);
	assert.match(buildScript, /ThirdPartyNotices-CuaDriver/);
	assert.match(packageDriverScript, /cua-driver-artifacts\.json/);
	assert.match(packageDriverScript, /isSymbolicLink\(\)/);
	assert.match(packageDriverScript, /TeamIdentifier/);
	assert.match(packageDriverScript, /sourceSha256/);
	assert.match(packageDriverScript, /renameSync\(temporary, destination\)/);
	const launcher = readFileSync("mac/TroublemakerMac/LauncherSupport.swift", "utf8");
	assert.match(launcher, /Resources.*cua-driver|resourceURL/);
	assert.match(launcher, /TROUBLEMAKER_DISTRIBUTABLE_MAC/);
	assert.doesNotMatch(launcher, /TROUBLEMAKER_COMPUTER_MODE/);
	assert.match(localRunScript, /settings\.computerMode === undefined\) settings\.computerMode = "cua"/);
	const notice = readFileSync("packaging/ThirdPartyNotices-CuaDriver.txt", "utf8");
	assert.match(notice, /MIT AND MPL-2\.0/);
	assert.match(notice, /Mozilla Public License Version 2\.0/);

	const dir = mkdtempSync(join(tmpdir(), "troublemaker-package-rollback-"));
	try {
		const destination = join(dir, "cua-driver");
		const invalid = join(dir, "invalid-driver");
		writeFileSync(destination, "last-good");
		writeFileSync(invalid, "not executable");
		const failedUpgrade = spawnSync(process.execPath, [packageDriverScriptPath, invalid, destination, "com.example.synthetic"], { encoding: "utf8" });
		assert.notEqual(failedUpgrade.status, 0);
		assert.equal(readFileSync(destination, "utf8"), "last-good");
		for (const hostId of [undefined, "invalid", "bad bundle id"]) {
			const args = [packageDriverScriptPath, invalid, destination];
			if (hostId !== undefined) args.push(hostId);
			const invalidHost = spawnSync(process.execPath, args, { encoding: "utf8" });
			assert.notEqual(invalidHost.status, 0);
			assert.match(invalidHost.stderr, /bundle ID|required/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Codex OAuth runtime strips OpenAI API-key authority before launch", () => {
	assert.match(localRunScript, /MOM_MODEL_PROVIDER/);
	assert.match(localRunScript, /settings\.defaultProvider/);
	assert.match(localRunScript, /MODEL_PROVIDER="\$\(selected_model_provider\)"/);
	assert.match(localRunScript, /if \[ "\$MODEL_PROVIDER" = "openai-codex" \]; then\s+unset OPENAI_API_KEY MOM_OPENAI_API_KEY/);
	const providerGuard = localRunScript.indexOf('if [ "$MODEL_PROVIDER" = "openai-codex" ]');
	const apiKeyLoad = localRunScript.indexOf("load_keychain_secret OPENAI_API_KEY", providerGuard);
	assert.ok(providerGuard >= 0, "missing openai-codex provider guard");
	assert.ok(apiKeyLoad > providerGuard, "API keys must only load after the openai-codex guard");
});

test("local model provider resolution honors env precedence and fails closed on malformed settings", () => {
	const functionStart = localRunScript.indexOf("selected_model_provider() {");
	const functionEnd = localRunScript.indexOf('\n\nfor arg in "$@"; do', functionStart);
	assert.ok(functionStart >= 0 && functionEnd > functionStart, "missing provider resolver");
	const functionSource = localRunScript.slice(functionStart, functionEnd);
	const workspace = mkdtempSync(join(tmpdir(), "troublemaker-provider-test-"));
	const settingsPath = join(workspace, "settings.json");
	const resolveProvider = (provider) => {
		const env = { ...process.env };
		if (provider === undefined) delete env.MOM_MODEL_PROVIDER;
		else env.MOM_MODEL_PROVIDER = provider;
		const result = spawnSync(
			"bash",
			["-c", `set -euo pipefail\nWORKSPACE_DIR="$1"\n${functionSource}\nselected_model_provider`, "provider-test", workspace],
			{ encoding: "utf8", env },
		);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};

	try {
		writeFileSync(settingsPath, JSON.stringify({ defaultProvider: " OPENAI-CODEX " }));
		assert.equal(resolveProvider(undefined), "openai-codex");
		assert.equal(resolveProvider(" FireWorks "), "fireworks");
		writeFileSync(settingsPath, "{not-json");
		assert.equal(resolveProvider(undefined), "");
		writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 42 }));
		assert.equal(resolveProvider(undefined), "");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("Mac app build rejects bad identities before local fallback", () => {
	assert.match(buildScript, /TROUBLEMAKER_SIGNING_IDENTITY/);
	assert.match(buildScript, /security find-identity -v -p codesigning/);
	assert.match(buildScript, /spctl --assess --type execute/);
	assert.match(buildScript, /CODESIGN_RESULT/);
	assert.match(buildScript, /sign_for_local_use/);
	assert.match(buildScript, /codesign --verify --deep --strict/);
	assert.match(buildScript, /com\.apple\.quarantine/);
	assert.match(buildScript, /com\.apple\.provenance/);
});

test("Mac app install is transactional and verifies the exact launched binary", () => {
	assert.match(runScript, /TROUBLEMAKER_SKIP_INSTALL=1/);
	assert.match(runScript, /mktemp -d \/tmp\/troublemaker-install/);
	assert.match(runScript, /Troublemaker\.app\.previous/);
	assert.match(runScript, /rollback_install/);
	assert.match(runScript, /stop_stale_project_runtime/);
	assert.match(runScript, /codesign --verify --deep --strict/);
	assert.match(runScript, /lipo "\$INSTALLED_EXECUTABLE" -verify_arch/);
	assert.match(runScript, /launchctl submit -l "\$LOCAL_JOB_LABEL"/);
	assert.match(runScript, /RUNNING_EXECUTABLE=.*ps -p/);
	assert.match(runScript, /RUNNING_EXECUTABLE" != "\$INSTALLED_EXECUTABLE/);
	assert.doesNotMatch(runScript, /rm -rf "\$INSTALL_PATH"/);
	assert.doesNotMatch(runScript, /codesign --force.*"\$INSTALL_PATH"/);
});
