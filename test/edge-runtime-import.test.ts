import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runEdgeWebChat } from "../src/modes/edge/index.js";

assert.equal(typeof runEdgeWebChat, "function");

const edgeFiles = [
	"src/modes/edge/index.ts",
	"src/modes/edge/pi-session.ts",
	"src/modes/edge/tools.ts",
	"src/modes/edge/host-bridge.ts",
	"src/modes/edge/r2-compat.ts",
];

for (const file of edgeFiles) {
	const content = readFileSync(join(process.cwd(), file), "utf-8");
	assert.equal(
		content.includes("@earendil-works/pi-coding-agent"),
		false,
		`${file} must not import pi-coding-agent's Node/TUI entrypoints`,
	);
}

console.log("edge-runtime-import ok");
