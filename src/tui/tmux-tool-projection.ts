import { execFileSync, spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";
import type { TerminalToolCallView } from "./tool-inspector.js";
import { sanitizeDetail } from "./tool-inspector.js";

export const TMUX_TOOL_PROJECTION_OPTION = "@troublemaker_tool_projection_dir";
const PROJECTION_DIRECTORY_PREFIX = "troublemaker-tui-tools-";
const PROJECTION_MARKER = ".troublemaker-tool-projection";
const PROJECTION_MARKER_CONTENT = "troublemaker-tui-tool-projection-v1\n";
const MAX_PROJECTION_SECTION_CHARACTERS = 24_000;
const MAX_PROJECTION_CHARACTERS = 128_000;

export type TmuxCommandRunner = (args: readonly string[]) => string;

export interface TmuxToolProjectionPublisherOptions {
	paneId?: string;
	tempRoot?: string;
	runTmux?: TmuxCommandRunner;
	disabled?: boolean;
}

export interface TmuxToolViewer {
	command: string;
	args: (projectionPath: string) => string[];
}

export type ToolViewerRunner = (viewer: TmuxToolViewer, projectionPath: string) => void;

export interface ViewTmuxToolProjectionOptions {
	paneId: string;
	selector: string;
	runTmux?: TmuxCommandRunner;
	tempRoot?: string;
	viewer?: TmuxToolViewer;
	runViewer?: ToolViewerRunner;
}

/**
 * Publishes owner-only Markdown snapshots for the tmux pane hosting this TUI.
 * Tmux owns the selection UI, so popup inspection never edits the composer.
 */
export class TmuxToolProjectionPublisher {
	private readonly paneId: string | undefined;
	private readonly runTmux: TmuxCommandRunner;
	private projectionDir: string | undefined;
	private readonly contentBySelector = new Map<number, string>();

	constructor(options: TmuxToolProjectionPublisherOptions = {}) {
		this.paneId = options.paneId ?? process.env.TMUX_PANE;
		this.runTmux = options.runTmux ?? runTmux;
		if (options.disabled || process.env.TROUBLEMAKER_TUI_DISABLE_TMUX_PROJECTION === "1") return;
		if (!this.paneId || !isTmuxPaneId(this.paneId) || (!process.env.TMUX && options.paneId === undefined)) return;

		let projectionDir: string | undefined;
		try {
			const root = options.tempRoot ?? tmpdir();
			projectionDir = mkdtempSync(join(root, PROJECTION_DIRECTORY_PREFIX));
			chmodSync(projectionDir, 0o700);
			writeFileSync(join(projectionDir, PROJECTION_MARKER), PROJECTION_MARKER_CONTENT, { mode: 0o600 });
			this.runTmux(["set-option", "-p", "-t", this.paneId, TMUX_TOOL_PROJECTION_OPTION, projectionDir]);
			this.projectionDir = projectionDir;
		} catch {
			if (projectionDir) rmSync(projectionDir, { recursive: true, force: true });
			this.projectionDir = undefined;
		}
	}

	get active(): boolean {
		return this.projectionDir !== undefined;
	}

	get directory(): string | undefined {
		return this.projectionDir;
	}

	sync(calls: readonly TerminalToolCallView[]): void {
		if (!this.projectionDir) return;
		try {
			const activeSelectors = new Set<number>();
			for (const call of calls) {
				activeSelectors.add(call.selector);
				const content = formatToolProjectionMarkdown(call);
				if (this.contentBySelector.get(call.selector) === content) continue;
				const destination = join(this.projectionDir, projectionFilename(call.selector));
				const temporary = join(this.projectionDir, `.${projectionFilename(call.selector)}.${process.pid}.tmp`);
				writeFileSync(temporary, content, { mode: 0o600 });
				chmodSync(temporary, 0o600);
				renameSync(temporary, destination);
				chmodSync(destination, 0o600);
				this.contentBySelector.set(call.selector, content);
			}

			for (const selector of this.contentBySelector.keys()) {
				if (activeSelectors.has(selector)) continue;
				rmSync(join(this.projectionDir, projectionFilename(selector)), { force: true });
				this.contentBySelector.delete(selector);
			}
		} catch {
			this.dispose();
		}
	}

	dispose(): void {
		const projectionDir = this.projectionDir;
		this.projectionDir = undefined;
		this.contentBySelector.clear();
		if (!projectionDir) return;
		if (this.paneId) {
			try {
				const current = this.runTmux(["show-options", "-p", "-v", "-t", this.paneId, TMUX_TOOL_PROJECTION_OPTION]).trim();
				if (current === projectionDir) {
					this.runTmux(["set-option", "-p", "-u", "-t", this.paneId, TMUX_TOOL_PROJECTION_OPTION]);
				}
			} catch {
				// The pane or tmux server may already have exited.
			}
		}
		rmSync(projectionDir, { recursive: true, force: true });
	}
}

export function formatToolProjectionMarkdown(call: TerminalToolCallView): string {
	let hasDetails = false;
	const lines = [
		`# Tool [${call.selector}]`,
		"",
		`- **Label:** ${markdownInline(call.label || call.name || "tool")}`,
		`- **Tool:** ${markdownInline(call.name || "tool")}`,
		`- **Status:** ${call.state}`,
	];
	if (Object.keys(call.arguments).length > 0) {
		hasDetails = true;
		lines.push("", "## Arguments", "", fencedBlock(JSON.stringify(call.arguments, null, 2), "json"));
	}
	for (const output of call.outputs) {
		hasDetails = true;
		const metadata = typeof output.pid === "number" ? ` (pid ${output.pid})` : "";
		lines.push("", `## ${markdownInline(output.stream)}${metadata}`, "", fencedBlock(output.text));
	}
	if (call.result) {
		hasDetails = true;
		lines.push("", `## ${call.result.isError ? "Error" : "Result"}`, "", fencedBlock(call.result.result));
	}
	if (!hasDetails) lines.push("", "_No arguments or output received._");
	const markdown = `${lines.join("\n")}\n`;
	if (markdown.length <= MAX_PROJECTION_CHARACTERS) return markdown;
	const suffix = "\n\n_Projection truncated to 128,000 characters._\n";
	return `${markdown.slice(0, MAX_PROJECTION_CHARACTERS - suffix.length)}${suffix}`;
}

export function viewTmuxToolProjection(options: ViewTmuxToolProjectionOptions): void {
	if (!isTmuxPaneId(options.paneId)) throw new Error("Invalid tmux pane identifier");
	const runner = options.runTmux ?? runTmux;
	const selector = normalizeSelector(options.selector.trim());
	const projectionDir = runner([
		"show-options",
		"-p",
		"-v",
		"-t",
		options.paneId,
		TMUX_TOOL_PROJECTION_OPTION,
	]).trim();
	if (!projectionDir) throw new Error("No active tool projection is attached to this pane");
	const projectionPath = resolveToolProjectionPath(projectionDir, selector, options.tempRoot ?? tmpdir());
	const viewer = options.viewer ?? findToolViewer();
	if (!viewer) throw new Error("Install bat to view tool projections in a tmux popup");
	(options.runViewer ?? runToolViewer)(viewer, projectionPath);
}

export function resolveToolProjectionPath(projectionDir: string, selectorValue: string | number, tempRoot = tmpdir()): string {
	const selector = normalizeSelector(String(selectorValue));
	const root = realpathSync(tempRoot);
	const directory = realpathSync(projectionDir);
	if (directory !== root && !directory.startsWith(`${root}${sep}`)) throw new Error("Tool projection is outside the private runtime directory");
	if (!basename(directory).startsWith(PROJECTION_DIRECTORY_PREFIX)) throw new Error("Invalid tool projection directory");
	assertOwnerOnly(directory, true);
	const marker = join(directory, PROJECTION_MARKER);
	assertOwnerOnly(marker, false);
	if (readFileSync(marker, "utf8") !== PROJECTION_MARKER_CONTENT) throw new Error("Invalid tool projection marker");

	const candidate = join(directory, projectionFilename(selector));
	const resolved = realpathSync(candidate);
	if (dirname(resolved) !== directory) throw new Error("Tool projection escaped its private directory");
	assertOwnerOnly(resolved, false);
	return resolved;
}

function normalizeSelector(value: string): number {
	if (!/^[1-9][0-9]{0,5}$/.test(value)) {
		throw new Error(`Tool selector must be a positive number with at most six digits (received ${JSON.stringify(value.slice(0, 32))})`);
	}
	return Number.parseInt(value, 10);
}

function projectionFilename(selector: number): string {
	return `tool-${selector}.md`;
}

function assertOwnerOnly(path: string, directory: boolean): void {
	const stats = lstatSync(path);
	if (directory ? !stats.isDirectory() : !stats.isFile()) throw new Error("Invalid tool projection file type");
	if ((stats.mode & 0o077) !== 0) throw new Error("Tool projection permissions are not owner-only");
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error("Tool projection has a different owner");
}

function markdownInline(value: string): string {
	return sanitizeDetail(value)
		.replace(/\s+/g, " ")
		.trim()
		.replace(/([\\`*_{}\[\]()<>#+.!|\-])/g, "\\$1") || "tool";
}

function fencedBlock(value: string, language = "text"): string {
	const bounded = sanitizeDetail(value).slice(0, MAX_PROJECTION_SECTION_CHARACTERS);
	const longestFence = Math.max(0, ...[...bounded.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longestFence + 1));
	return `${fence}${language}\n${bounded || "(empty)"}\n${fence}`;
}

function findToolViewer(): TmuxToolViewer | undefined {
	for (const command of ["bat", "batcat"]) {
		const executable = findExecutable(command);
		if (!executable) continue;
		return {
			command: executable,
			args: (path) => ["--style=plain", "--color=always", "--paging=always", "--language=markdown", path],
		};
	}
	const less = findExecutable("less");
	return less ? { command: less, args: (path) => ["-R", path] } : undefined;
}

function findExecutable(command: string): string | undefined {
	for (const directory of (process.env.PATH || "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	return undefined;
}

function isTmuxPaneId(value: string): boolean {
	return /^%[0-9]+$/.test(value);
}

function runToolViewer(viewer: TmuxToolViewer, projectionPath: string): void {
	const result = spawnSync(viewer.command, viewer.args(projectionPath), { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Tool projection viewer exited with status ${result.status ?? "unknown"}`);
}

function runTmux(args: readonly string[]): string {
	return execFileSync("tmux", [...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}
