import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	DEFAULT_COMPACTION_TIMEOUT_MS,
	resolveCompactionTimeoutMs,
} from "../src/agent.js";

assert.equal(resolveCompactionTimeoutMs(undefined), DEFAULT_COMPACTION_TIMEOUT_MS, "compaction timeout has a bounded default");
assert.equal(resolveCompactionTimeoutMs("invalid"), DEFAULT_COMPACTION_TIMEOUT_MS, "invalid timeout configuration fails safe");
assert.equal(resolveCompactionTimeoutMs("1000"), 30_000, "compaction timeout clamps unsafe short values");
assert.equal(resolveCompactionTimeoutMs(String(60 * 60 * 1000)), 30 * 60 * 1000, "compaction timeout clamps unsafe long values");
assert.equal(resolveCompactionTimeoutMs("90000"), 90_000, "compaction timeout accepts a bounded override");

const agentSource = await readFile(new URL("../src/agent.ts", import.meta.url), "utf8");
assert.match(agentSource, /compactionTimer = setTimeout[\s\S]*?requestCompactionAbort\(\)/, "compaction owns an exact cancellation timer");
assert.match(agentSource, /boundCompactionStreamOptions\(context, options\)/, "compaction request shaping is applied at the shared stream boundary");
assert.match(agentSource, /abort\(\): void[\s\S]*?requestCompactionAbort\(\)[\s\S]*?session\.abort\(\)/, "normal abort also reaches Pi's separate compaction controller");
assert.match(agentSource, /getCompactionStatus\(\): CompactionStatus \| null/, "runner exposes structured compaction status");

const cliSource = await readFile(new URL("../src/host/node/cli.ts", import.meta.url), "utf8");
assert.match(cliSource, /Boolean\(awareness\?\.runner\.getCompactionStatus\(\)\)/, "an uninitialized runner is not mistaken for active compaction");
assert.match(cliSource, /phase = compaction \? "compacting" : busy \? "running" : "idle"/, "status exposes the current operation phase");
assert.match(cliSource, /queuedInputCount: queuedInterrupts \+ queuedVoiceTurns/, "status exposes queued input count");
assert.match(cliSource, /Stale compaction detected[\s\S]*?abortCompaction\(\)/, "watchdog cancels stale compaction without clearing queued steering");

const tuiSource = await readFile(new URL("../src/tui/app.ts", import.meta.url), "utf8");
assert.match(tuiSource, /Compacting context[\s\S]*?formatElapsed\(status\.phaseElapsedMs\)/, "TUI continuously labels compaction with elapsed time");
assert.match(tuiSource, /input.*queued/, "TUI surfaces queued input count");

console.log("compaction QoL: ok");
