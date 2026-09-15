# Handoff compaction

With `compaction.mode` set to `handoff`, the runtime creates a schema-validated continuity checkpoint and rotates into a fresh session.

For telemetry-backed local inference, pressure checkpoints are **transactional**. The triggering user message is persisted normally, but checkpoint generation runs through a separate private provider request that is not attached to `AgentSession`. The private request exposes only `handoff_context`, forces that tool, disables reasoning, uses deterministic sampling, and rejects prose or multiple tool calls. Its assistant response, tool arguments, and result are therefore never appended to `context.jsonl`, streamed to Computer/TUI, or published through awareness. Only a validated checkpoint can enter the rotation journal and hidden continuity entry.

Older non-local paths retain the in-session compatibility mechanism. The manually constructed Pi agent connects `transformContext` to the current session extension runner so those lifecycle hooks remain functional.

## Local prefill safety

When `TROUBLEMAKER_INFERENCE_PROGRESS_URL` is a valid loopback MTPLX telemetry endpoint, local safety defaults to:

- hard uncached-prefill ceiling: `24,000` tokens
- automatic handoff threshold: ceiling minus a `4,000`-token safety margin
- private checkpoint timeout: `120,000` ms, including queue time

Override the ceiling with `TROUBLEMAKER_LOCAL_PREFILL_LIMIT_TOKENS` (4,096 to 200,000) and the private timeout with `TROUBLEMAKER_PRIVATE_HANDOFF_TIMEOUT_MS` (10,000 to 300,000).

The guard uses `totalTokens - cachedTokens`, not total context size. A 30K context with a 28K cache hit is allowed; a genuine 30K cache miss is cancelled on the next telemetry poll. Provider retries are disabled for guarded local requests. The runtime then attempts one bounded private checkpoint and continues in fresh context. If recovery fails, the accepted user message remains durable and the run fails explicitly instead of spending many minutes on a giant prefill.

Private checkpoint input is text-only and bounded below the hard ceiling. Normal-sized histories retain their available dialogue, compact tool-call and tool-result excerpts, and prior hidden continuity summary. An already oversized history retains its opening task contract, newest prior continuity summary, and recent working tail. The model receives an explicit omission notice and must preserve uncertainty rather than invent middle-history details. Full source history remains available in the archive after successful rotation.

## Rotation and continuation

Rotation first journals its validated intent and archives the source conversation. The new session contains the hidden checkpoint and at most four recent dialogue messages within a 4,096-character aggregate budget. Retained dialogue omits tool calls, tool results, images, and stale usage counters. Oversized messages are omitted whole. The checkpoint is continuity data, not new authority to act.

After an automatic pressure-triggered rotation, unfinished work resumes within the same canonical run. The continuation does not replay the accepted user message, its delivery ID, attachments, or fresh-context reset. Cancellation is checked between segments. Explicit and scheduled maintenance compaction use the same private checkpoint path but do not persist their maintenance prompt or automatically resume task work.

A malformed, timed-out, cancelled, or interrupted private request appends no checkpoint assistant/tool messages. The legitimate triggering user entry remains the active leaf, so restart recovery cannot select an abandoned private branch. Startup closes stale `preparing` transition metadata as `aborted`.

The first request after rotation must process the new checkpoint and retained context; it cannot reuse the removed conversation prefix in full. Measure checkpoint generation separately from this first post-rotation request.

## Concurrency

Public runner operations serialize `run` and `compact`. Explicit slash-command compaction also holds the host's canonical run slot so new ingress observes the busy state. Interactive input arriving during maintenance waits and then runs once. Stop remains outside the operation queue and directly aborts an active private checkpoint request.

A server restart is not a substitute for compaction. Deploy only at a verified idle boundary, preserve the session and archives, and avoid competing inference workloads during measurements.

## Verification and limits

Run `pnpm test:handoff-compaction` and `pnpm exec tsc --noEmit`. The suite covers parsing, private-output exclusion, bounded checkpoint input, bounded retained history, journal replay, continuation, cancellation, malformed checkpoints, explicit maintenance, concurrent user ingress, and a synthetic 30K uncached-prefill rejection followed by bounded recovery.

These tests establish harness behavior, not model checkpoint quality. Before claiming a deployment verified, measure one successful checkpoint and first post-rotation turn on the actual model/runtime using content-free transition and prefill metadata. Confirm `preparing → completed`, an uncached checkpoint input below the configured ceiling, no checkpoint prose/tool row in clients, and a healthy fresh-context continuation. A failed or overlapping run is not a successful checkpoint measurement.
