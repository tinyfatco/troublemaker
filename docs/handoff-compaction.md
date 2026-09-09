# Handoff compaction

With `compaction.mode` set to `handoff`, the runtime requests a checkpoint from the existing conversation. It appends a short control message to the provider context instead of sending the transcript to a separate summarization prompt. Existing message order and tool schemas remain unchanged. This preserves eligibility for prefix-cache reuse; actual hits still depend on the inference server retaining compatible cache entries.

The manually constructed Pi agent connects `transformContext` to the current session extension runner. `AgentSession` lifecycle hooks alone do not install this SDK connection. Without it, the runtime can flag checkpoint mode while never sending the checkpoint instruction to the provider.

## Rotation and continuation

The model emits a private structured checkpoint. During that request, ordinary tool execution is blocked without removing tool definitions from the provider prefix. Checkpoints have a bounded output allowance and are validated before rotation. A malformed or interrupted checkpoint preserves the existing session; malformed checkpoints produce an explicit failure rather than a successful empty response.

Rotation first journals its intent and archives the source conversation. The new session contains the checkpoint and at most four recent dialogue messages within a 4,096-character aggregate budget. Retained dialogue omits tool calls, tool results, images, and stale usage counters. Oversized messages are omitted whole. Full source content remains in the archive. The checkpoint is continuity data, not new authority to act.

After an automatic pressure-triggered rotation, unfinished work resumes within the same canonical run. The continuation does not replay the accepted user message, its delivery ID, attachments, or fresh-context reset. Cancellation is checked between segments. Explicit and scheduled maintenance compaction use the same checkpoint path but do not automatically resume task work.

The first request after rotation must process the new checkpoint and retained context; it cannot reuse the removed conversation prefix in full. Measure checkpoint generation separately from this first post-rotation request.

## Concurrency

Public runner operations serialize `run` and `compact`. Explicit slash-command compaction also holds the host's canonical run slot so new ingress observes the busy state. Interactive input arriving during maintenance waits and then runs once. Stop remains outside the operation queue.

A server restart is not a substitute for compaction. Deploy only at a verified idle boundary, preserve the session and archives, and avoid competing inference workloads during measurements.

## Verification and limits

Run `pnpm test:handoff-compaction` and `pnpm exec tsc --noEmit`. The suite covers parsing, output privacy, bounded retained history, journal replay, continuation, cancellation, malformed checkpoints, blocked tool execution, explicit maintenance, and concurrent user ingress. Its full-runner test uses a loopback fake provider with synthetic usage counts to exercise pressure without constructing a large prompt. It verifies the original provider prefix and tool schemas, checkpoint delivery, source archival, and subsequent continuation.

These tests establish harness behavior, not model checkpoint quality or real cache latency. Before claiming a deployment verified, measure a successful checkpoint and the first post-rotation turn on its actual model/runtime, inspect cache-hit counters, confirm task continuity and retained-history bounds, and check client behavior. A failed or overlapping run is not a valid successful checkpoint measurement. Do not treat a passing synthetic test as proof that a model will obey the checkpoint protocol or avoid unrelated reasoning loops.
