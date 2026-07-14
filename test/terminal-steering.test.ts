import assert from "node:assert/strict";
import type { MomEvent } from "../src/adapters/types.js";
import { formatTerminalTuiSteer, tryTerminalTuiSoftSteer } from "../src/terminal-steering.js";

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
