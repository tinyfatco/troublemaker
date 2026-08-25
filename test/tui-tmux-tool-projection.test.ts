import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalToolCallView } from "../src/tui/tool-inspector.js";
import {
	formatToolProjectionMarkdown,
	resolveToolProjectionPath,
	TMUX_TOOL_PROJECTION_OPTION,
	TmuxToolProjectionPublisher,
	viewTmuxToolProjection,
	type TmuxCommandRunner,
} from "../src/tui/tmux-tool-projection.js";

const tempRoot = await mkdtemp(join(tmpdir(), "troublemaker-tmux-projection-test-"));
const commands: string[][] = [];
let paneProjection = "";
const runTmux: TmuxCommandRunner = (rawArgs) => {
	const args = [...rawArgs];
	commands.push(args);
	if (args[0] === "show-options") return paneProjection;
	if (args[0] === "set-option" && args.includes("-u")) {
		paneProjection = "";
		return "";
	}
	if (args[0] === "set-option") {
		assert.equal(args.at(-2), TMUX_TOOL_PROJECTION_OPTION);
		paneProjection = args.at(-1) || "";
		return "";
	}
	throw new Error(`Unexpected tmux command: ${args[0]}`);
};

const call: TerminalToolCallView = {
	selector: 12,
	identity: "tool:synthetic-tool-12",
	id: "synthetic-tool-12",
	name: "example_tool",
	label: "Inspect `synthetic` output",
	arguments: { path: "/tmp/example.txt", marker: "SYNTHETIC_ARGUMENT" },
	outputs: [{
		type: "toolOutput",
		toolCallId: "synthetic-tool-12",
		stream: "stdout",
		text: "SYNTHETIC_OUTPUT\n```\n\u001b[31mred\u001b[0m\u0000\n",
		pid: 1234,
	}],
	result: {
		type: "toolResult",
		toolCallId: "synthetic-tool-12",
		result: "SYNTHETIC_RESULT",
		isError: false,
	},
	state: "success",
	expanded: false,
};

const publisher = new TmuxToolProjectionPublisher({ paneId: "%7", tempRoot, runTmux });
try {
	assert.equal(publisher.active, true);
	assert.equal(paneProjection, publisher.directory);
	publisher.sync([call]);

	const directory = publisher.directory;
	assert(directory);
	const projectionPath = join(directory, "tool-12.md");
	const projectionStat = await stat(projectionPath);
	assert.equal(projectionStat.mode & 0o777, 0o600, "tool projections are owner-only");
	const markdown = await readFile(projectionPath, "utf8");
	assert.match(markdown, /^# Tool \[12\]/);
	assert.match(markdown, /SYNTHETIC_ARGUMENT/);
	assert.match(markdown, /SYNTHETIC_OUTPUT/);
	assert.match(markdown, /SYNTHETIC_RESULT/);
	assert.match(markdown, /````text\nSYNTHETIC_OUTPUT/, "embedded Markdown fences cannot close the projection block");
	assert.doesNotMatch(markdown, /\u001b|\u0000/, "terminal control bytes do not enter projection files");
	assert.equal(resolveToolProjectionPath(directory, "12", tempRoot), await realpath(projectionPath));
	assert.throws(() => resolveToolProjectionPath(directory, "../../12", tempRoot), /selector/);
	assert.throws(() => resolveToolProjectionPath(tempRoot, "12", tempRoot), /directory/);

	await chmod(projectionPath, 0o644);
	assert.throws(() => resolveToolProjectionPath(directory, "12", tempRoot), /owner-only/);
	await chmod(projectionPath, 0o600);

	let viewedPath = "";
	viewTmuxToolProjection({
		paneId: "%7",
		selector: "12",
		runTmux,
		tempRoot,
		viewer: {
			command: "/opt/example tools/bat",
			args: (path) => ["--language=markdown", path],
		},
		runViewer: (viewer, path) => {
			assert.equal(viewer.command, "/opt/example tools/bat");
			assert.deepEqual(viewer.args(path), ["--language=markdown", path]);
			viewedPath = path;
		},
	});
	assert.equal(viewedPath, await realpath(projectionPath));
	assert.throws(() => viewTmuxToolProjection({ paneId: "%7", selector: "0", runTmux, tempRoot }), /positive number/);

	const formatted = formatToolProjectionMarkdown({ ...call, arguments: {}, outputs: [], result: undefined });
	assert.match(formatted, /No arguments or output received/);
} finally {
	publisher.dispose();
	assert.equal(paneProjection, "", "disposing the publisher clears only its pane projection");
	assert.equal(publisher.directory, undefined);
	await rm(tempRoot, { recursive: true, force: true });
}

console.log("troublemaker TUI tmux tool projection tests passed");
