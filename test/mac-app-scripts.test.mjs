import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const buildScriptPath = "scripts/build-mac-app.sh";
const runScriptPath = "scripts/run-dev.sh";
const buildScript = readFileSync(buildScriptPath, "utf8");
const runScript = readFileSync(runScriptPath, "utf8");

test("Mac app scripts are valid Bash", () => {
	for (const scriptPath of [buildScriptPath, runScriptPath]) {
		const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
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
