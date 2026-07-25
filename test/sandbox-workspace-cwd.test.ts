import assert from "node:assert/strict";
import type { Executor } from "../src/sandbox.js";
import { withExecutorCwd } from "../src/sandbox.js";

const commands: string[] = [];
const base: Executor = {
	async exec(command) {
		commands.push(command);
		return { stdout: "", stderr: "", code: 0 };
	},
	getWorkspacePath(path) {
		return path === "/host/customer" ? "/data" : path;
	},
};

const scoped = withExecutorCwd(base, "/host/customer");
await scoped.exec("pwd && touch customer-check.txt");

assert.equal(commands[0], "cd '/data' && pwd && touch customer-check.txt");
assert.equal(scoped.getWorkspacePath("/host/customer"), "/data");

console.log("sandbox workspace cwd ok");
