import assert from "node:assert/strict";
import type { MomEvent } from "../src/adapters/types.js";
import { formatInstructionsForEvent, formatTerminalTuiSteer, TERMINAL_TUI_FORMAT_INSTRUCTIONS, tryTerminalTuiSoftSteer } from "../src/terminal-steering.js";

const event: MomEvent = {
	type: "dm",
	channel: "terminal:demo-agent",
	ts: "123",
	user: "terminal-user",
	text: "look at the newer results instead",
	sourceEventType: "terminal_tui",
	directlyAddressed: true,
};
const now = new Date("2026-01-02T03:04:05.000Z");

assert.equal(
	formatTerminalTuiSteer(event, now),
	"[2026-01-02T03:04:05.000Z] [terminal:demo-agent] [terminal]: look at the newer results instead",
);

const prompts: string[] = [];
assert.equal(tryTerminalTuiSoftSteer(event, {
	steer(prompt) {
		prompts.push(prompt);
		return true;
	},
}, now), true);
assert.deepEqual(prompts, [formatTerminalTuiSteer(event, now)]);

assert.equal(tryTerminalTuiSoftSteer({ ...event, sourceEventType: "web_message" }, {
	steer() {
		throw new Error("non-terminal traffic must not use the soft-steer exception");
	},
}, now), false);

assert.equal(tryTerminalTuiSoftSteer(event, { steer: () => false }, now), false);

console.log("terminal TUI steering tests passed");

// Terminal TUI turns arrive through the web adapter but must not be told they are in web chat.
{
	const web = "## Web Chat Formatting (Markdown)";
	assert.equal(formatInstructionsForEvent({ sourceEventType: "terminal_tui" }, web), TERMINAL_TUI_FORMAT_INSTRUCTIONS);
	assert.match(TERMINAL_TUI_FORMAT_INSTRUCTIONS, /terminal/i);
	assert.doesNotMatch(TERMINAL_TUI_FORMAT_INSTRUCTIONS, /web chat/i);
	assert.equal(formatInstructionsForEvent({ sourceEventType: "web_voice" }, web), web);
	assert.equal(formatInstructionsForEvent({}, web), web);
}
