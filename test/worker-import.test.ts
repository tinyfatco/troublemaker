/**
 * Ensures the Worker-facing host contract stays free of Node runtime imports.
 *
 * This is intentionally narrower than "bundle the whole runtime" for now.
 * The broader refactor should move the import target upward as each Node
 * assumption is inverted behind HostServices.
 */

import { execFile } from "child_process";
import { rmSync } from "fs";

const probes = [
	["src/core/runtime.ts", "/tmp/troublemaker-core-runtime.js"],
	["src/host/worker/contract.ts", "/tmp/troublemaker-worker-contract.js"],
] as const;

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { cwd: process.cwd() }, (error, _stdout, stderr) => {
			if (error) {
				reject(new Error(stderr || error.message));
				return;
			}
			resolve();
		});
		child.stdout?.pipe(process.stdout);
		child.stderr?.pipe(process.stderr);
	});
}

for (const [entry, outfile] of probes) {
	await run("npx", [
		"esbuild",
		entry,
		"--bundle",
		"--platform=browser",
		"--format=esm",
		`--outfile=${outfile}`,
		"--log-level=warning",
	]);
	rmSync(outfile, { force: true });
}

console.log("Worker-facing runtime contracts bundle for Worker/browser");
