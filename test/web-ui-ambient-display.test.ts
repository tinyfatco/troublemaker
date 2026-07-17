import { cleanAmbientLineForDisplay, getAmbientDisplayLines } from "../ui/src/ambientDisplay.ts";
import { formatChannel, parseContextLine } from "../ui/src/types.ts";

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

const currentAmbient = `[AMBIENT] A conversation is happening in slack:#tinyfat. New unseen, complete messages since your last ambient wake:

<ambient_messages>
Alex (U09V58YC33R) [Reply target: slack:C0AN1GL51K7:1779777014.658729; message_ts: 1779777020.000100; thread_ts: 1779777014.658729]: please answer inside this thread
</ambient_messages>

Channel pulse: 4 messages in last 15min, 2 participants, you last spoke 80s ago.

You're observing this conversation naturally.`;

const currentLines = getAmbientDisplayLines(currentAmbient);
assert(currentLines.length === 1, "current ambient wrapper renders one unseen line");
assert(currentLines[0] === "Alex: please answer inside this thread", "current ambient display strips routing metadata");
assert(!currentLines.join("\n").includes("Channel pulse"), "current ambient display omits pulse context");
assert(!currentLines.join("\n").includes("Reply target"), "current ambient display omits reply target metadata");

const bareSteeredAmbient = parseContextLine(JSON.stringify({
	type: "message",
	id: "bare-steered-ambient",
	timestamp: "2026-07-17T18:00:00Z",
	message: {
		role: "user",
		content: [{
			type: "text",
			text: `<session_context>private model context</session_context>\n\n${currentAmbient}`,
		}],
	},
}));
assert(bareSteeredAmbient?.isAmbient === true, "bare steered ambient context is classified before rendering");
assert(bareSteeredAmbient?.channel === "slack:#tinyfat", "bare steered ambient context keeps its source channel");
assert(bareSteeredAmbient?.userName === "system", "bare steered ambient context is never labeled as a user");
assert(getAmbientDisplayLines(bareSteeredAmbient?.strippedText || "")[0] === "Alex: please answer inside this thread", "bare steered ambient rendering retains only the posted message");
assert(formatChannel(bareSteeredAmbient?.channel || "").type === "slack", "prefixed Slack ambient channels keep Slack presentation");

const legacyAmbient = `[AMBIENT] A conversation is happening in #tinyfat. Recent messages:

Mike (U123): this should still render

Channel pulse: 1 messages in last 15min.`;

assert(getAmbientDisplayLines(legacyAmbient)[0] === "Mike: this should still render", "legacy ambient wrappers remain readable");
assert(cleanAmbientLineForDisplay("Sam (U999) [Reply target: slack:C:1]: hello") === "Sam: hello", "line cleanup is reusable");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
