import assert from "node:assert/strict";
import {
	buildRealtimeContextHandoff,
	createRealtimeContextItem,
	createRealtimeTruncationConfig,
	estimateRealtimeTokens,
	isBenignRealtimeCancellationError,
	realtimeContextConfig,
	type RealtimeContextHandoff,
} from "../ui/src/realtimeContext.ts";
import type { AwarenessEntry } from "../ui/src/types.ts";

const config = realtimeContextConfig("gpt-realtime-2");
assert.equal(config.contextWindowTokens, 32000, "Realtime context window defaults around 32k tokens");
assert.equal(config.postInstructionsTokenLimit, 27904, "Realtime keeps output headroom outside the handoff cap");
assert.deepEqual(
	createRealtimeTruncationConfig("gpt-realtime-2"),
	{
		type: "retention_ratio",
		retention_ratio: 0.8,
		token_limits: { post_instructions: 27904 },
	},
	"Realtime truncation uses an explicit post-instructions cap",
);

const entries = Array.from({ length: 36 }, (_, index): AwarenessEntry => ({
	id: `entry-${index}`,
	type: "message",
	timestamp: `2026-06-12T00:${String(index).padStart(2, "0")}:00.000Z`,
	role: index % 2 === 0 ? "user" : "assistant",
	content: [{ type: "text", text: `context turn ${index} ${"detail ".repeat(80)}` }],
	channel: "web",
	userName: index % 2 === 0 ? "you" : undefined,
	strippedText: index % 2 === 0 ? `context turn ${index} ${"detail ".repeat(80)}` : undefined,
}));

const compact = mustHandoff(buildRealtimeContextHandoff(entries, {
	model: "gpt-realtime-2",
	totalEntryCount: 60,
	tokenLimit: 1000,
}));
assert.equal(compact.compacted, true, "Oversized or partial context receives a compact handoff");
assert(compact.warning?.includes("compact context handoff"), "Compacted handoff includes a user-visible warning");
assert(compact.includedEntryCount < compact.totalEntryCount, "Compacted handoff reports omitted context");
assert(estimateRealtimeTokens(compact.text) <= 1000, "Compacted handoff respects the configured token limit");
assert(compact.text.includes("context turn 35"), "Compaction preserves the newest useful context");
assert(!compact.text.includes("context turn 0"), "Compaction drops older entries first");

const item = createRealtimeContextItem(compact);
assert.equal(item.type, "conversation.item.create", "Context handoff is sent as a passive conversation item");
const handoffItem = item.item as Record<string, unknown>;
assert.equal(handoffItem.type, "message");
assert.equal(handoffItem.role, "user");

assert.equal(
	isBenignRealtimeCancellationError({
		type: "error",
		error: { message: "Cancellation failed: no active response found" },
	}),
	true,
	"Known Realtime no-active-response cancel race is benign",
);
assert.equal(
	isBenignRealtimeCancellationError({
		type: "error",
		error: { message: "Realtime transcription failed" },
	}),
	false,
	"Non-cancellation Realtime errors still surface",
);

console.log("web realtime context handoff tests passed");

function mustHandoff(value: RealtimeContextHandoff | null): RealtimeContextHandoff {
	assert(value, "expected context handoff");
	return value;
}
