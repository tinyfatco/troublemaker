import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expectPath = "/usr/bin/expect";
const tmuxProbe = spawnSync("tmux", ["-V"], { stdio: "ignore" });
const expectProbe = spawnSync(expectPath, ["-v"], { stdio: "ignore" });

if (tmuxProbe.status !== 0 || expectProbe.status !== 0) {
	console.log("troublemaker TUI tmux popup PTY test skipped (tmux or expect unavailable)");
} else {
	const tempRoot = await mkdtemp(join(tmpdir(), "troublemaker-tmux-popup-pty-"));
	const socketName = `troublemaker-popup-test-${process.pid}`;
	const sessionName = "tool-popup-test";
	const isolatedEnvironment = { ...process.env };
	delete isolatedEnvironment.TMUX;
	delete isolatedEnvironment.TMUX_PANE;
	const fixturePath = join(tempRoot, "projection-host.mjs");
	const projectionModuleUrl = pathToFileURL(resolve("dist/tui/tmux-tool-projection.js")).href;
	const tuiEntrypoint = resolve("dist/tui.js");
	let serverStarted = false;

	try {
		await writeFile(fixturePath, `
import { TmuxToolProjectionPublisher } from ${JSON.stringify(projectionModuleUrl)};

const publisher = new TmuxToolProjectionPublisher({ paneId: process.env.TMUX_PANE, tempRoot: process.argv[2] });
publisher.sync([{
  selector: 12,
  identity: "tool:synthetic-popup-12",
  id: "synthetic-popup-12",
  name: "example_tool",
  label: "Synthetic popup check",
  arguments: { marker: "SYNTHETIC_POPUP_ARGUMENT" },
  outputs: [],
  result: { type: "toolResult", toolCallId: "synthetic-popup-12", result: "SYNTHETIC_POPUP_RESULT", isError: false },
  state: "success",
  expanded: false,
}]);
if (!publisher.active) throw new Error("projection publisher did not attach to the tmux pane");
console.log("PROJECTION_READY");
const stop = () => { publisher.dispose(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
setInterval(() => {}, 1_000);
`, { mode: 0o600 });

		const hostCommand = [process.execPath, fixturePath, tempRoot].map(shellQuote).join(" ");
		tmux(["-f", "/dev/null", "new-session", "-d", "-s", sessionName, hostCommand]);
		serverStarted = true;
		const paneId = tmux(["display-message", "-p", "-t", `${sessionName}:0.0`, "#{pane_id}"]).trim();
		assert.match(paneId, /^%[0-9]+$/);
		tmux(["set-option", "-g", "prefix2", "C-t"]);

		const popupShellCommand = [
			process.execPath,
			tuiEntrypoint,
			"tmux-view",
		].map(shellQuote).join(" ");
		const binding = `display-popup -E -w 90% -h 85% -e TROUBLEMAKER_TOOL_SELECTOR=%1 -e TROUBLEMAKER_TMUX_PANE=#{pane_id} -T "Tool details" "${escapeDoubleQuoted(popupShellCommand)}"`;
		tmux(["bind-key", "-T", "prefix", "g", "command-prompt", "-F", "-p", "Tool number:", binding]);

		const expectScript = `
set timeout 12
spawn -noecho tmux -L {${socketName}} attach-session -t {${sessionName}}
expect {
  {PROJECTION_READY} {}
  timeout { puts stderr "Projection host readiness timeout"; exit 2 }
  eof { puts stderr "tmux client exited before projection readiness"; exit 3 }
}
send -- "\\024g"
expect {
  {Tool number:} {}
  timeout { puts stderr "Tool selector prompt timeout"; exit 4 }
  eof { puts stderr "tmux client exited before selector prompt"; exit 5 }
}
send -- "12\\r"
expect {
  {Synthetic popup check} {}
  timeout { puts stderr "Projected Markdown popup readiness timeout"; exit 6 }
  eof { puts stderr "tmux client exited before popup content"; exit 7 }
}
send -- "G"
expect {
  {SYNTHETIC_POPUP_RESULT} {}
  timeout { puts stderr "Projected Markdown result timeout"; exit 8 }
  eof { puts stderr "tmux client exited before popup result"; exit 9 }
}
send -- "q"
after 250
send -- "\\024d"
expect eof
`;
		const terminal = spawn(expectPath, ["-c", expectScript], {
			cwd: process.cwd(),
			env: { ...isolatedEnvironment, TERM: "xterm-256color" },
		});
		let output = "";
		terminal.stdout.on("data", (data: Buffer) => { output = `${output}${data.toString("utf8")}`.slice(-100_000); });
		terminal.stderr.on("data", (data: Buffer) => { output = `${output}${data.toString("utf8")}`.slice(-100_000); });
		const exitCode = await new Promise<number | null>((resolvePromise) => terminal.on("exit", resolvePromise));
		assert.equal(exitCode, 0, output.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""));
		assert.match(output, /SYNTHETIC_POPUP_RESULT/);
		console.log("troublemaker TUI tmux popup PTY test passed");
	} finally {
		if (serverStarted) {
			try {
				tmux(["kill-server"]);
			} catch {
				// The attached client may already have ended the isolated server.
			}
		}
		await rm(tempRoot, { recursive: true, force: true });
	}

	function tmux(args: string[]): string {
		return execFileSync("tmux", ["-L", socketName, ...args], { encoding: "utf8", env: isolatedEnvironment });
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeDoubleQuoted(value: string): string {
	return value.replace(/([\\"$`])/g, "\\$1");
}
