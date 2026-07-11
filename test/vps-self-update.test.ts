import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const requestScript = join(root, "scripts/vps/request-update.sh");
const updateScript = join(root, "scripts/vps/update-runtime.sh");
const directory = await mkdtemp(join(tmpdir(), "troublemaker-update-request-"));

for (const script of [requestScript, updateScript]) {
	const syntax = spawnSync("sh", ["-n", script], { encoding: "utf8" });
	assert.equal(syntax.status, 0, syntax.stderr);
}

await chmod(directory, 0o770);
const requested = spawnSync("sh", [requestScript, "staging"], {
	encoding: "utf8",
	env: { ...process.env, ZIP_UPDATE_REQUEST_DIR: directory },
});
assert.equal(requested.status, 0, requested.stderr);
assert.equal(await readFile(join(directory, "staging.request"), "utf8"), "");

const rejected = spawnSync("sh", [requestScript, "feature-branch"], {
	encoding: "utf8",
	env: { ...process.env, ZIP_UPDATE_REQUEST_DIR: directory },
});
assert.equal(rejected.status, 2);

const pathUnit = await readFile(join(root, "ops/vps/zip-updater@.path"), "utf8");
assert.match(pathUnit, /PathExists=\/run\/zip-updater\/%i\.request/);
const serviceUnit = await readFile(join(root, "ops/vps/zip-updater@.service"), "utf8");
assert.match(serviceUnit, /ExecStartPre=.*rm -f \/run\/zip-updater\/%i\.request/);
assert.match(serviceUnit, /ExecStart=\/usr\/local\/lib\/zip-updater\/update-runtime %i/);

const updater = await readFile(updateScript, "utf8");
assert.match(updater, /install -d -m 0755 -o zip-builder -g zip-builder "\$CANDIDATE"/);
assert.match(updater, /npm ci --no-audit --no-fund/);
assert.match(updater, /mv "\$REPO" "\$PREVIOUS"/);
assert.match(updater, /curl -fsS "\$HEALTH_URL"/);
assert.match(updater, /mv "\$PREVIOUS" "\$REPO"/);
