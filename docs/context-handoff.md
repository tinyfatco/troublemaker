# Context handoff

`handoff_context` is a discoverable agent tool. Supply a concise `summary`, `nextSteps` as plain text or an array, and `continue` (true to continue unfinished work; false to wait). Call it alone after other tools complete. The summary is generated in the existing conversation, without a separate summarization request. The harness supplies authoritative routing.

The tool stages the checkpoint and terminates the tool sequence. Rotation occurs at the safe boundary: archive the old conversation, persist the rotation journal, build the new context with a completion receipt and bounded, explicitly historical dialogue, then publish completion. Invalid checkpoints preserve the original context. A continuation cannot repeat the agent-requested rotation that created it. New user turns can request a new handoff. Automatic context-pressure checkpoints remain available for genuinely long continuations. Stop/cancellation takes precedence over continuation. If steering or follow-up causes another model call before a staged tool handoff commits, that newer input supersedes the staged summary: the transition is aborted and the existing context is preserved. This does not activate emergency checkpoint instructions or tool blocking.

Automatic threshold handoff uses the same rotation receipt. Native compaction publishes the same lifecycle with kind `compaction`. Explicit maintenance compaction does not continue unfinished work automatically.

Public status events may contain `contextTransition`: version, id, kind, trigger, state, revision, startedAt, updatedAt, and optional token/retained-message counts. Lifecycle states are preparing, completed, failed, aborted, and skipped. Token counts are optional and must not be inferred when missing. Summaries and archive paths are not included in public receipts.

`GET /api/v2/agents/:agentId/context-transitions` returns `{transitions: [...]}` under the normal console authorization boundary. Up to 512 recent receipts are retained independently of model context. Clients upsert by transition ID and revision, keep terminal states, and never interpret reconnect/reset as successful compaction. Receipts are operational UI, not assistant speech or model input.

On process restart, an existing handoff rotation journal is replayed idempotently before normal context load. A surviving preparing receipt without a recoverable journal becomes aborted. Normal in-process continuation does not redeliver the original input. Retained dialogue is quoted historical reference rather than fresh user/assistant turns. Old harness continuations and checkpoint requests are excluded from the tail, so they cannot accumulate after rotations. Operational transition markers and the current continuation remain visible through their existing public channels. This release does not create an unattended continuation job after a process crash: the checkpoint remains available for the next input. It therefore avoids replaying potentially completed external actions on restart.

## Cache-aware resume foundation

`cache-resume-policy.ts` contains a tested decision function and bounded settings parser. Automatic activation is not wired into scheduled admission in this release. `cacheResume` settings default to disabled and are reserved for that integration; enabling the field alone does not schedule checkpoints or rotate context.

The missing prerequisite is a reliable, exact-prompt cache-restore probe. Last-turn cache statistics do not prove a future prompt can be restored. The policy distinguishes RAM/SSD restore, warm idle checkpoint, valid checkpoint resume, and unattended deferral. Unknown cache state never authorizes a destructive rotation. A checkpoint that omits important newer work is not eligible for cold resume.

Existing heartbeat configuration remains independent. No heartbeat settings are changed by installing this feature.

## Curated startup context

The compact prompt profile loads complete `AGENTS.md`, `IDENTITY.md`, `USER.md`, `SOUL.md`, `MEMORY.md`, and `HEARTBEAT.md` files, plus `BOOTSTRAP.md`, `BRIEF.md`, and active goal state when present. Keep these curated files small; they are not silently shortened to meet the external-input budget. Daily logs, transcripts, and task guides remain on demand.

The workspace snapshot is pinned for the context lifetime, including after a service restart. File changes take effect after a handoff, fresh reset, or compaction that removes the snapshot. Already-admitted provider projections remain byte-for-byte stable, including snapshots admitted under earlier truncation policies. Newly admitted harness workspace snapshots bypass the ordinary input limiter using structural provenance; user text and tool results cannot opt themselves out by imitating snapshot tags.

## User input and tool-output limits

Original user messages, including voice transcripts and steering, are admitted in full before provider-role conversion. They do not consume the per-item or aggregate tool-output budget. The exemption uses message provenance, not content matching. Tool results and file observations remain bounded. Existing saved projections take precedence even when an older user message was clipped; deployment never silently expands the cached past. Recovering an earlier message can use the existing detail reference without rewriting history.

Compact tool discovery includes already-active tools because their schemas are otherwise hidden behind the generic call interface. This makes `input_detail` retrievable without altering the provider's cached tool definitions.
