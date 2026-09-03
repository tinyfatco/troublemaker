import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
	DEFAULT_COMPACTION_TIMEOUT_MS,
	resolveCompactionTimeoutMs,
} from "../src/agent.js";
import {
	DEFAULT_COMPACTION_CUE_PATH,
	DEFAULT_COMPACTION_CUE_PLAYER,
	DEFAULT_COMPACTION_CUE_VOLUME,
	playCompactionCue,
	resolveCompactionCue,
} from "../src/compaction-cue.js";
import { DEFAULT_COMPACTION } from "../src/context.js";

assert.equal(DEFAULT_COMPACTION.reserveTokens, 16_384, "compaction uses Pi's native fixed response headroom");
assert.equal(DEFAULT_COMPACTION.keepRecentTokens, 20_000, "compaction uses Pi's native recent-context retention");

assert.equal(resolveCompactionTimeoutMs(undefined), DEFAULT_COMPACTION_TIMEOUT_MS, "compaction timeout has a bounded default");
assert.equal(resolveCompactionTimeoutMs("invalid"), DEFAULT_COMPACTION_TIMEOUT_MS, "invalid timeout configuration fails safe");
assert.equal(resolveCompactionTimeoutMs("1000"), 30_000, "compaction timeout clamps unsafe short values");
assert.equal(resolveCompactionTimeoutMs(String(60 * 60 * 1000)), 30 * 60 * 1000, "compaction timeout clamps unsafe long values");
assert.equal(resolveCompactionTimeoutMs("90000"), 90_000, "compaction timeout accepts a bounded override");

const cueExists = (path: string) => path === DEFAULT_COMPACTION_CUE_PLAYER || path === DEFAULT_COMPACTION_CUE_PATH;
assert.equal(resolveCompactionCue({ platform: "linux", exists: cueExists }), null, "non-Mac runtimes stay silent");
assert.equal(resolveCompactionCue({
	platform: "darwin",
	env: { MOM_COMPACTION_SOUND: "off" },
	exists: cueExists,
}), null, "operators can explicitly disable the cue");
assert.deepEqual(resolveCompactionCue({ platform: "darwin", env: {}, exists: cueExists }), {
	player: DEFAULT_COMPACTION_CUE_PLAYER,
	sound: DEFAULT_COMPACTION_CUE_PATH,
	volume: DEFAULT_COMPACTION_CUE_VOLUME,
}, "Mac runtimes use the subtle built-in cue by default");
assert.equal(resolveCompactionCue({
	platform: "darwin",
	env: { MOM_COMPACTION_SOUND_VOLUME: "4" },
	exists: cueExists,
})?.volume, 1, "configured cue volume is safely bounded");

let spawned: { command: string; args: string[]; unref: boolean } | null = null;
assert.equal(playCompactionCue({
	platform: "darwin",
	env: {},
	exists: cueExists,
	spawn(command, args) {
		spawned = { command, args, unref: false };
		return {
			once() {},
			unref() { if (spawned) spawned.unref = true; },
		};
	},
}), true, "cue playback starts without blocking compaction");
assert.deepEqual(spawned, {
	command: DEFAULT_COMPACTION_CUE_PLAYER,
	args: ["-v", String(DEFAULT_COMPACTION_CUE_VOLUME), DEFAULT_COMPACTION_CUE_PATH],
	unref: true,
}, "cue playback uses direct, low-volume afplay arguments and detaches");

const agentSource = await readFile(new URL("../src/agent.ts", import.meta.url), "utf8");
assert.match(agentSource, /compactionTimer = setTimeout[\s\S]*?requestCompactionAbort\(\)/, "compaction owns an exact cancellation timer");
assert.match(agentSource, /boundCompactionStreamOptions\(context, options\)/, "compaction request shaping is applied at the shared stream boundary");
assert.match(agentSource, /abort\(\): void[\s\S]*?requestCompactionAbort\(\)[\s\S]*?session\.abort\(\)/, "normal abort also reaches Pi's separate compaction controller");
assert.match(agentSource, /getCompactionStatus\(\): CompactionStatus \| null/, "runner exposes structured compaction status");
assert.match(agentSource, /alreadyCompacting[\s\S]*?if \(!alreadyCompacting\) playCompactionCue\(\)/, "each distinct compaction operation plays one cue");

const cliSource = await readFile(new URL("../src/host/node/cli.ts", import.meta.url), "utf8");
assert.match(cliSource, /Boolean\(awareness\?\.runner\.getCompactionStatus\(\)\)/, "an uninitialized runner is not mistaken for active compaction");
assert.match(cliSource, /phase = compaction \? "compacting" : busy \? "running" : "idle"/, "status exposes the current operation phase");
assert.match(cliSource, /queuedInputCount: queuedInterrupts \+ queuedVoiceTurns/, "status exposes queued input count");
assert.match(cliSource, /Stale compaction detected[\s\S]*?abortCompaction\(\)/, "watchdog cancels stale compaction without clearing queued steering");

const tuiSource = await readFile(new URL("../src/tui/app.ts", import.meta.url), "utf8");
assert.match(tuiSource, /Compacting context[\s\S]*?formatElapsed\(status\.phaseElapsedMs\)/, "TUI continuously labels compaction with elapsed time");
assert.match(tuiSource, /pendingLocalEchoes[\s\S]*?formatWaitingInputStatus/, "TUI surfaces the next local waiting prompt during compaction");
const waitingInputSource = await readFile(new URL("../src/tui/waiting-input.ts", import.meta.url), "utf8");
assert.match(waitingInputSource, /count-only privacy fallback/, "non-local queued work remains private");
assert.match(waitingInputSource, /truncateToWidth/, "waiting prompts respect terminal display width");

console.log("compaction QoL: ok");
