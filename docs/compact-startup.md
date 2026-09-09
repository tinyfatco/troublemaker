# Compact startup and measured input processing

`TROUBLEMAKER_PROMPT_PROFILE=compact` opts a **new process** into an experimental OpenAI-compatible chat-completions profile. The default prompt and tool interface are unchanged. Do not change this setting in the middle of a conversation. Preserve the session and switch at an explicit fresh-context boundary.

The compact profile includes the complete workspace `AGENTS.md`, `IDENTITY.md`, `USER.md`, current `BRIEF.md`, and active goal. Bootstrap instructions remain complete when present. It lists historical memory, personality, and skill files as available but not loaded, and reads them on demand. It never silently truncates binding rules to meet a token target. Large rules or briefs can therefore exceed the intended small startup budget.

The provider always receives `search_tools` and `call_tool`. Search activates real tools internally, but their definitions do not expand the provider's schema prefix. `call_tool` responses are translated into real tool calls before Pi executes them, preserving native validation, tool hooks, cancellation, and rejection of truncated tool calls. Stored history retains real tool names. The first harness workspace snapshot is projected before the initial user routing/message, so changing the first question need not invalidate the stable workspace prefix. Later workspace updates remain in their original order. A deterministic provider projection restores the compact representation on subsequent requests without changing that history. The model must still learn this interface; offline token counts and synthetic execution tests are not a substitute for live quality and cache measurements.

## Optional progress telemetry

`TROUBLEMAKER_INFERENCE_PROGRESS_URL` can point to an operator-configured **loopback HTTP** MTPLX snapshot endpoint. No endpoint is guessed. Each inference request receives a unique `x-mtplx-request-id`; any intermediary proxy must preserve this header. Only the matching request's numerical prefill measurements are forwarded. Missing or failed telemetry does not block inference. Redirects and non-loopback destinations are rejected.

The portable status event optionally carries:

```json
{
  "type": "status",
  "status": "processing",
  "processing": {
    "phase": "prefill",
    "processedTokens": 512,
    "totalTokens": 1024,
    "cachedTokens": 256,
    "elapsedSeconds": 2
  }
}
```

Console conversation streams preserve the bounded `processing` object on their `state` event. No model text, provider request IDs, or private provider response fields cross this contract. Processing status never becomes assistant text or speech. Clients without this extension continue showing their normal activity indicator. A percentage describes input preparation, not completion of the user's overall task.

## Verification

Run the compact prompt, compact tool surface, search tool, inference progress, handoff compaction, and conversation contract tests, then compile TypeScript. The tool-surface test uses a synthetic provider to exercise Pi's real execution loop, including rejected arguments, blocked calls, and truncated responses. Before enabling for a live agent, additionally verify actual model tool selection, first-use discovery, prefix-cache reuse after discovery, fresh-context startup, and normal handoff behavior. Do not benchmark against a server already handling an interactive or background task.

See [handoff compaction](handoff-compaction.md) for rotation, continuation, concurrency, and verification details.
