import { cleanAmbientLineForDisplay, getAmbientDisplayLines } from "../ui/src/ambientDisplay.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ok ${msg}`);
	} else {
		failed++;
		console.error(`  FAIL ${msg}`);
	}
}

const currentAmbient = `[AMBIENT] A conversation is happening in #tinyfat. New unseen messages since your last ambient wake:

Alex (U09V58YC33R) [Reply target: slack:C0AN1GL51K7:1779777014.658729; message_ts: 1779777020.000100; thread_ts: 1779777014.658729]: please answer inside this thread

Channel pulse: 4 messages in last 15min, 2 participants, you last spoke 80s ago.

You're observing this conversation naturally.`;

const currentLines = getAmbientDisplayLines(currentAmbient);
assert(currentLines.length === 1, "current ambient wrapper renders one unseen line");
assert(currentLines[0] === "Alex: please answer inside this thread", "current ambient display strips routing metadata");
assert(!currentLines.join("\n").includes("Channel pulse"), "current ambient display omits pulse context");
assert(!currentLines.join("\n").includes("Reply target"), "current ambient display omits reply target metadata");

const legacyAmbient = `[AMBIENT] A conversation is happening in #tinyfat. Recent messages:

Mike (U123): this should still render

Channel pulse: 1 messages in last 15min.`;

assert(getAmbientDisplayLines(legacyAmbient)[0] === "Mike: this should still render", "legacy ambient wrappers remain readable");
assert(cleanAmbientLineForDisplay("Sam (U999) [Reply target: slack:C:1]: hello") === "Sam: hello", "line cleanup is reusable");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
