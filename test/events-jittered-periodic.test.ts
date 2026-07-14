import assert from "node:assert/strict";
import { planNextJitteredPeriodicRun, type PeriodicEvent } from "../src/events.js";

const heartbeat: PeriodicEvent = {
	type: "periodic",
	text: "heartbeat",
	schedule: "0 */12 * * *",
	timezone: "America/Los_Angeles",
	spontaneity: 0.5,
};

// At 23:54 Pacific, maximum negative jitter fires before the midnight slot.
const nowMs = Date.parse("2026-07-14T06:54:00.000Z");
const first = planNextJitteredPeriodicRun(heartbeat, nowMs, 0);
assert(first);
assert.equal(new Date(first.baseRunMs).toISOString(), "2026-07-14T07:00:00.000Z");
assert.equal(first.delayMs, 3 * 60 * 1000);

// Rescheduling from that consumed slot must advance to noon Pacific rather
// than selecting midnight again and clustering another heartbeat nearby.
const earlyFireMs = nowMs + first.delayMs;
const second = planNextJitteredPeriodicRun(heartbeat, earlyFireMs, 0.5, first.baseRunMs);
assert(second);
assert.equal(new Date(second.baseRunMs).toISOString(), "2026-07-14T19:00:00.000Z");

// If quiet-hours deferral outlives one or more cron slots, resume from now and
// skip stale boundaries instead of replaying them every 90 seconds.
const hourly: PeriodicEvent = {
	type: "periodic",
	text: "hourly",
	schedule: "0 * * * *",
	timezone: "UTC",
	spontaneity: 0.5,
};
const delayedNowMs = Date.parse("2026-07-14T07:00:00.000Z");
const delayed = planNextJitteredPeriodicRun(
	hourly,
	delayedNowMs,
	0.5,
	Date.parse("2026-07-14T00:00:00.000Z"),
);
assert(delayed);
assert.equal(new Date(delayed.baseRunMs).toISOString(), "2026-07-14T08:00:00.000Z");

console.log("events jittered-periodic tests passed");
