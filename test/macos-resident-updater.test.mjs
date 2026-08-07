import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestScript = path.join(root, "scripts", "macos-resident-request-update.sh");
const updaterScript = path.join(root, "scripts", "macos-resident-updater.sh");

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeConfig(file, values) {
	writeFileSync(
		file,
		Object.entries(values)
			.map(([key, value]) => `${key}=${shellQuote(value)}`)
			.join("\n") + "\n",
		{ mode: 0o600 },
	);
}

function createReleaseRepository(temp) {
	const source = path.join(temp, "source");
	const bare = path.join(temp, "release.git");
	mkdirSync(source);
	run("/usr/bin/git", ["init", "--initial-branch=release"], { cwd: source });
	run("/usr/bin/git", ["config", "user.name", "Updater Test"], { cwd: source });
	run("/usr/bin/git", ["config", "user.email", "updater@example.com"], { cwd: source });
	mkdirSync(path.join(source, "scripts"));
	writeFileSync(path.join(source, ".gitignore"), "dist/\nnode_modules/\n");
	writeFileSync(path.join(source, "package.json"), '{"scripts":{"build":"mkdir -p dist && touch dist/main.js"}}\n');
	writeFileSync(path.join(source, "package-lock.json"), '{"lockfileVersion":3}\n');
	writeFileSync(path.join(source, "scripts", "run-local-mac.sh"), "#!/bin/bash\nexit 0\n");
	chmodSync(path.join(source, "scripts", "run-local-mac.sh"), 0o755);
	run("/usr/bin/git", ["add", "."], { cwd: source });
	run("/usr/bin/git", ["commit", "-m", "Create test resident"], { cwd: source });
	run("/usr/bin/git", ["init", "--bare", bare]);
	run("/usr/bin/git", ["remote", "add", "release", bare], { cwd: source });
	run("/usr/bin/git", ["push", "release", "release"], { cwd: source });
	const commit = run("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: source }).trim();
	return { bare, commit };
}

function writeServicePlist(file, workingDirectory) {
	writeFileSync(
		file,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.example.resident</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>${workingDirectory}/scripts/run-local-mac.sh</string><string>--no-build</string></array>
<key>WorkingDirectory</key><string>${workingDirectory}</string>
</dict></plist>
`,
	);
}

function createFakeCommands(temp, plist, oldRuntime, candidateHealthy) {
	const bin = path.join(temp, "bin");
	const launchState = path.join(temp, "launch-state");
	mkdirSync(bin);
	writeFileSync(launchState, "loaded\n");

	const launchctl = path.join(bin, "launchctl");
	writeFileSync(
		launchctl,
		`#!/bin/bash
set -eu
state=${shellQuote(launchState)}
case "$1" in
  print) test -f "$state"; echo "    pid = 4242" ;;
  bootout) rm -f "$state" ;;
  bootstrap) touch "$state" ;;
  enable|kickstart) exit 0 ;;
  *) exit 2 ;;
esac
`,
	);
	chmodSync(launchctl, 0o755);

	const curl = path.join(bin, "curl");
	writeFileSync(
		curl,
		`#!/bin/bash
set -eu
current=$(/usr/libexec/PlistBuddy -c 'Print:WorkingDirectory' ${shellQuote(plist)})
if [ ${candidateHealthy ? "1" : "0"} = 1 ] || [ "$current" = ${shellQuote(oldRuntime)} ]; then
  exit 0
fi
exit 1
`,
	);
	chmodSync(curl, 0o755);

	const npm = path.join(bin, "npm");
	writeFileSync(
		npm,
		`#!/bin/bash
set -eu
if [ "\${1:-}" = "ci" ]; then exit 0; fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build" ]; then mkdir -p dist; touch dist/main.js; exit 0; fi
exit 0
`,
	);
	chmodSync(npm, 0o755);
	return { launchctl, curl, npm };
}

async function withFixture(candidateHealthy, callback) {
	const temp = await mkdtemp(path.join(os.tmpdir(), "resident-updater-"));
	try {
		const { bare, commit } = createReleaseRepository(temp);
		const runtimeRoot = path.join(temp, "resident data");
		const queue = path.join(runtimeRoot, "host-updater", "queue");
		const oldRuntime = path.join(temp, "old runtime");
		const plist = path.join(temp, "resident.plist");
		mkdirSync(queue, { recursive: true });
		mkdirSync(path.join(oldRuntime, "scripts"), { recursive: true });
		writeFileSync(path.join(oldRuntime, "scripts", "run-local-mac.sh"), "#!/bin/bash\nexit 0\n");
		writeServicePlist(plist, oldRuntime);
		const commands = createFakeCommands(temp, plist, oldRuntime, candidateHealthy);
		const config = path.join(temp, "updater.conf");
		writeConfig(config, {
			RESIDENT_LABEL: "com.example.resident",
			RESIDENT_PLIST: plist,
			HEALTH_URL: "http://127.0.0.1:3000/health",
			REPOSITORY: bare,
			RUNTIME_ROOT: runtimeRoot,
			QUEUE_DIR: queue,
			GIT_BIN: "/usr/bin/git",
			NPM_BIN: commands.npm,
			LAUNCHCTL_BIN: commands.launchctl,
			CURL_BIN: commands.curl,
			HEALTH_ATTEMPTS: "1",
			HEALTH_INTERVAL_SECONDS: "0",
			STABILITY_SECONDS: "0",
		});
		run("/bin/bash", [requestScript, config, "release"]);
		await callback({ temp, commit, config, plist, queue, runtimeRoot, oldRuntime });
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

test("request helper pins the release branch commit", async () => {
	await withFixture(true, async ({ commit, queue }) => {
		const requests = readdirSync(queue).filter((name) => name.startsWith("request."));
		assert.equal(requests.length, 1);
		assert.equal(readFileSync(path.join(queue, requests[0]), "utf8"), `release\t${commit}\n`);
	});
});

test("independent updater activates a clean, healthy candidate", async () => {
	await withFixture(true, async ({ commit, config, plist, runtimeRoot }) => {
		run("/bin/bash", [updaterScript, config]);
		const activeRuntime = run("/usr/libexec/PlistBuddy", ["-c", "Print:WorkingDirectory", plist]).trim();
		assert.match(activeRuntime, new RegExp(`releases/source-${commit.slice(0, 12)}-`));
		assert.equal(run("/usr/bin/git", ["-C", activeRuntime, "status", "--porcelain"]), "");
		const receipt = readFileSync(path.join(runtimeRoot, "host-updater", "state", "last-success"), "utf8");
		assert.match(receipt, new RegExp(`commit=${commit}`));
	});
});

test("failed candidate health restores the previous plist", async () => {
	await withFixture(false, async ({ config, plist, oldRuntime, runtimeRoot }) => {
		assert.throws(() => run("/bin/bash", [updaterScript, config]));
		const activeRuntime = run("/usr/libexec/PlistBuddy", ["-c", "Print:WorkingDirectory", plist]).trim();
		assert.equal(activeRuntime, oldRuntime);
		const receipt = readFileSync(path.join(runtimeRoot, "host-updater", "state", "last-rollback"), "utf8");
		assert.match(receipt, /pid=4242/);
	});
});
