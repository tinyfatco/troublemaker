import assert from "node:assert/strict";
import {
  extractRealtimeResponseOutputItems,
  normalizeRealtimeOutputPhase,
  realtimeOutputIndexFromEvent,
  realtimeOutputKeyFromEvent,
  realtimeOutputPhaseFromEvent,
  realtimeOutputTextFromEvent,
} from "../ui/src/realtimePhases.ts";

assert.equal(normalizeRealtimeOutputPhase("commentary"), "commentary");
assert.equal(normalizeRealtimeOutputPhase("final_answer"), "final_answer");
assert.equal(normalizeRealtimeOutputPhase("final"), undefined);

assert.equal(
  realtimeOutputKeyFromEvent({ item_id: "item-a", output_index: 3 }, "fallback"),
  "item-a",
);
assert.equal(
  realtimeOutputKeyFromEvent({ output_index: 1 }, "fallback"),
  "output-1",
);
assert.equal(realtimeOutputIndexFromEvent({ output_index: 2 }), 2);
assert.equal(
  realtimeOutputPhaseFromEvent({ item: { phase: "commentary" } }),
  "commentary",
);
assert.equal(
  realtimeOutputTextFromEvent({ transcript: "I'll check that now.", text: "ignored" }),
  "I'll check that now.",
);

const outputs = extractRealtimeResponseOutputItems({
  type: "response.done",
  response: {
    output: [
      {
        id: "msg-preamble",
        type: "message",
        phase: "commentary",
        content: [
          {
            type: "output_audio",
            transcript: "I'll check that now.",
          },
        ],
      },
      {
        id: "msg-final",
        type: "message",
        phase: "final_answer",
        content: [
          {
            type: "output_audio",
            transcript: "It is ready for you to test.",
          },
        ],
      },
      {
        id: "call-1",
        type: "function_call",
        name: "bash",
        arguments: "{}",
      },
    ],
  },
});

assert.deepEqual(outputs, [
  {
    key: "msg-preamble",
    phase: "commentary",
    text: "I'll check that now.",
    outputIndex: 0,
  },
  {
    key: "msg-final",
    phase: "final_answer",
    text: "It is ready for you to test.",
    outputIndex: 1,
  },
]);

console.log("web realtime phase helpers ok");
