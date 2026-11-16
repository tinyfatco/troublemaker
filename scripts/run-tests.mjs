#!/usr/bin/env node
/**
 * Run every test file in the repository and report all failures at the end.
 *
 * Unlike the chained `pnpm run test:* && ...` scripts, a failing test does not
 * hide the rest: every file runs (in parallel, with a concurrency limit) and
 * the process exits nonzero if any file failed or timed out.
 *
 * Usage:
 *   pnpm test                         # run everything
 *   pnpm test -- --list               # print the discovered files and exit
 *   pnpm test -- slack voice          # only files whose path contains "slack" or "voice"
 *   pnpm test -- -j 1                 # run serially
 *   pnpm test -- --timeout 60         # per-file timeout in seconds (default 180)
 *   pnpm test -- --exclude tui-pty    # skip files whose path contains "tui-pty"
 *   pnpm test -- --verbose            # print every file's output, not only failures'
 *
 * Environment: TEST_CONCURRENCY, TEST_TIMEOUT_SECONDS, TEST_EXCLUDE (comma-separated).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories scanned (non-recursively) for `*.test.{ts,tsx,mjs}` files. */
const TEST_DIRS = ["test", "hostd/test", "ui/test"];

function parseArgs(argv) {
	const opts = {
		concurrency: Number(process.env.TEST_CONCURRENCY) || Math.max(1, Math.min(8, availableParallelism() - 1)),
		timeoutSeconds: Number(process.env.TEST_TIMEOUT_SECONDS) || 180,
		filters: [],
		excludes: (process.env.TEST_EXCLUDE ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		list: false,
		verbose: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		if (arg === "--") continue;
		else if (arg === "-j" || arg === "--concurrency") opts.concurrency = Math.max(1, Number(next()) || 1);
		else if (arg === "--timeout") opts.timeoutSeconds = Math.max(1, Number(next()) || 1);
		else if (arg === "--exclude") opts.excludes.push(next());
		else if (arg === "--list") opts.list = true;
		else if (arg === "-v" || arg === "--verbose") opts.verbose = true;
		else if (arg === "-h" || arg === "--help") {
			console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
			process.exit(0);
		} else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		else opts.filters.push(arg);
	}
	return opts;
}

function discover() {
	const files = [];
	for (const dir of TEST_DIRS) {
		const abs = join(root, dir);
		if (!existsSync(abs)) continue;
		for (const name of readdirSync(abs).sort()) {
			if (/\.test\.(ts|tsx|mjs)$/.test(name)) files.push(`${dir}/${name}`);
		}
	}
	return files;
}

function commandFor(file) {
	const tsx = join(root, "node_modules", ".bin", "tsx");
	if (file.endsWith(".mjs")) return [process.execPath, ["--test", file]];
	const usesNodeTest = /from\s+["']node:test["']/.test(readFileSync(join(root, file), "utf8"));
	// Files under a package with its own tsconfig (e.g. ui/ for JSX) need that config.
	const pkg = file.split("/")[0];
	const tsconfig = pkg !== "test" && existsSync(join(root, pkg, "tsconfig.json")) ? ["--tsconfig", `${pkg}/tsconfig.json`] : [];
	return [tsx, [...tsconfig, ...(usesNodeTest ? ["--test"] : []), file]];
}

function runFile(file, timeoutMs) {
	return new Promise((resolvePromise) => {
		const [cmd, args] = commandFor(file);
		const started = Date.now();
		const child = spawn(cmd, args, {
			cwd: root,
			env: { ...process.env, FORCE_COLOR: "0" },
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group so a timeout can kill grandchildren too.
			detached: process.platform !== "win32",
		});
		const chunks = [];
		child.stdout.on("data", (d) => chunks.push(d));
		child.stderr.on("data", (d) => chunks.push(d));
		let timedOut = false;
		const kill = (signal) => {
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				// already exited
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill("SIGTERM");
			setTimeout(() => kill("SIGKILL"), 5000).unref();
		}, timeoutMs);
		activeChildren.add(kill);
		const finish = (code, signal, error) => {
			clearTimeout(timer);
			activeChildren.delete(kill);
			// Reap any background processes the test left in its group.
			if (code !== null || signal) kill("SIGKILL");
			resolvePromise({
				file,
				ok: !timedOut && !error && code === 0,
				timedOut,
				code,
				signal,
				ms: Date.now() - started,
				output: Buffer.concat(chunks).toString("utf8") + (error ? `\n${error.stack ?? error}` : ""),
			});
		};
		child.on("error", (error) => finish(null, null, error));
		child.on("close", (code, signal) => finish(code, signal));
	});
}

const activeChildren = new Set();
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		for (const kill of activeChildren) kill("SIGKILL");
		process.exit(130);
	});
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	let files = discover();
	if (opts.filters.length) files = files.filter((f) => opts.filters.some((p) => f.includes(p)));
	if (opts.excludes.length) files = files.filter((f) => !opts.excludes.some((p) => f.includes(p)));

	if (opts.list) {
		for (const f of files) console.log(f);
		return 0;
	}
	if (files.length === 0) {
		console.error("No test files matched.");
		return 1;
	}

	const width = String(files.length).length;
	console.log(`Running ${files.length} test files (concurrency ${opts.concurrency}, timeout ${opts.timeoutSeconds}s)\n`);
	const startedAll = Date.now();
	const results = [];
	let done = 0;
	const queue = [...files];
	const worker = async () => {
		for (let file = queue.shift(); file; file = queue.shift()) {
			const result = await runFile(file, opts.timeoutSeconds * 1000);
			results.push(result);
			done++;
			const status = result.ok ? "pass" : result.timedOut ? "TIMEOUT" : "FAIL";
			console.log(`[${String(done).padStart(width)}/${files.length}] ${status.padEnd(7)} ${file} (${(result.ms / 1000).toFixed(1)}s)`);
			if (opts.verbose && result.output.trim()) console.log(indent(result.output));
		}
	};
	await Promise.all(Array.from({ length: Math.min(opts.concurrency, files.length) }, worker));

	const failed = results.filter((r) => !r.ok).sort((a, b) => a.file.localeCompare(b.file));
	if (failed.length && !opts.verbose) {
		for (const r of failed) {
			console.log(`\n${"=".repeat(72)}\n${r.timedOut ? "TIMEOUT" : "FAIL"}: ${r.file} (exit ${r.code ?? r.signal})\n${"=".repeat(72)}`);
			console.log(tail(r.output, 80));
		}
	}
	const secs = ((Date.now() - startedAll) / 1000).toFixed(1);
	console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total in ${secs}s`);
	for (const r of failed) console.log(`  ${r.timedOut ? "timeout" : "failed "}  ${relative(root, join(root, r.file))}`);
	return failed.length ? 1 : 0;
}

function indent(text) {
	return text.replace(/\s+$/, "").replace(/^/gm, "    ");
}

function tail(text, lines) {
	const all = text.replace(/\s+$/, "").split("\n");
	const shown = all.slice(-lines).join("\n");
	return all.length > lines ? `... (${all.length - lines} earlier lines omitted)\n${shown}` : shown;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	},
);
