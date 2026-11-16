import { readdirSync, readFileSync } from "node:fs";

/**
 * Source text of the agent runner: src/agent.ts followed by its modules in
 * src/runner/. Source-shape assertions about the runner read this instead of
 * src/agent.ts alone, so they keep holding when code moves between them.
 */
export function readRunnerSource(): string {
	const root = new URL("../../", import.meta.url);
	const runnerDir = new URL("src/runner/", root);
	const modules = readdirSync(runnerDir).filter((name) => name.endsWith(".ts")).sort();
	return [new URL("src/agent.ts", root), ...modules.map((name) => new URL(name, runnerDir))]
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
}
