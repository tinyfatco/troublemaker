import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/modes/edge/index.ts", "utf8");

assert(source.includes("emitRunComplete?: boolean"), "edge web chat exposes a completion emission option");
assert(
	source.includes("if (options.emitRunComplete !== false)") &&
		source.indexOf("if (options.emitRunComplete !== false)") < source.indexOf('type: "run_complete"'),
	"run_complete is gated so callers can persist turn state before completing the stream",
);

console.log("edge-run-complete-option ok");
