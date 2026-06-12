import assert from "node:assert/strict";
import {
	buildContextWindowStatus,
	estimateAwarenessContextTokens,
	formatContextTokens,
} from "../ui/src/contextWindowStatus.ts";
import type { AwarenessEntry } from "../ui/src/types.ts";

const entries: AwarenessEntry[] = [
	{
		id: "session",
		type: "session",
		timestamp: "2026-06-12T00:00:00.000Z",
	},
	{
		id: "user",
		type: "message",
		timestamp: "2026-06-12T00:00:01.000Z",
		role: "user",
		content: [{
			type: "text",
			text: "<session_context>hidden token ballast</session_context>[2026-06-12] [web] [user]: hello",
		}],
		strippedText: "hello",
	},
	{
		id: "assistant",
		type: "message",
		timestamp: "2026-06-12T00:00:02.000Z",
		role: "assistant",
		content: [{ type: "text", text: "world" }],
	},
];

const estimate = estimateAwarenessContextTokens(entries);
assert(estimate > 0, "visible messages produce a token estimate");
assert(estimate < 10, "hidden session context is not counted in the visible estimate");
assert.equal(formatContextTokens(32000), "32k", "token caps use compact k formatting");

const recent = buildContextWindowStatus(entries, { allLoaded: false, realtimeVoice: true });
assert.equal(recent.contextLabel, `~${formatContextTokens(estimate)} loaded`, "context label exposes the current estimate without debug prefixes");
assert.equal(recent.sourceLabel, "2 recent messages", "partial awareness history is marked as recent");
assert.equal(recent.realtime?.capTokens, 32000, "Realtime voice status exposes the 32k-ish cap");
assert.equal(recent.realtime?.label, "voice handoff ready", "Realtime label avoids always-visible token soup");
assert.equal(recent.realtime?.stateLabel, "direct handoff", "small Realtime context uses direct handoff copy");

const largeEntries = Array.from({ length: 140 }, (_, index): AwarenessEntry => ({
	id: `large-${index}`,
	type: "message",
	timestamp: `2026-06-12T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
	role: index % 2 === 0 ? "user" : "assistant",
	content: [{ type: "text", text: "detail ".repeat(900) }],
}));

const large = buildContextWindowStatus(largeEntries, { allLoaded: true, realtimeVoice: true });
assert.equal(large.sourceLabel, "140 loaded messages", "fully loaded awareness history shows the message count");
assert.equal(large.realtime?.stateLabel, "compact handoff", "oversized Realtime context reports compact handoff when inspected");
assert.equal(large.realtime?.tone, "attention", "oversized Realtime context uses attention tone without an alarm label");

console.log("web UI context-window status ok");
