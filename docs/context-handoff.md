# Context handoff

`handoff_context` is a discoverable agent tool. Supply a concise `summary`, `nextSteps` as plain text or an array, and `continue` (true to continue unfinished work; false to wait). Call it alone after other tools complete. The summary is generated in the existing conversation, without a separate summarization request. The harness supplies authoritative routing.

The tool stages the checkpoint and terminates the tool sequence. Rotation occurs at the safe boundary: archive the old conversation, persist the rotation journal, build the new context with a bounded recent tail, then publish completion. Invalid checkpoints preserve the original context. A canonical run permits at most eight agent-requested rotations. Stop/cancellation takes precedence over continuation.

Automatic threshold handoff uses the same rotation receipt. Native compaction publishes the same lifecycle with kind `compaction`. Explicit maintenance compaction does not continue unfinished work automatically.

Public status events may contain `contextTransition`: version, id, kind, trigger, state, revision, startedAt, updatedAt, and optional token/retained-message counts. Lifecycle states are preparing, completed, failed, aborted, and skipped. Token counts are optional and must not be inferred when missing. Summaries and archive paths are not included in public receipts.

`GET /api/v2/agents/:agentId/context-transitions` returns `{transitions: [...]}` under the normal console authorization boundary. Up to 512 recent receipts are retained independently of model context. Clients upsert by transition ID and revision, keep terminal states, and never interpret reconnect/reset as successful compaction. Receipts are operational UI, not assistant speech or model input.

On process restart, an existing handoff rotation journal is replayed idempotently before normal context load. A surviving preparing receipt without a recoverable journal becomes aborted. Normal in-process continuation does not redeliver the original input. This release does not create an unattended continuation job after a process crash: the checkpoint remains available for the next input. It therefore avoids replaying potentially completed external actions on restart.

## Cache-aware resume foundation

`cache-resume-policy.ts` contains a tested decision function and bounded settings parser. Automatic activation is not wired into scheduled admission in this release. `cacheResume` settings default to disabled and are reserved for that integration; enabling the field alone does not schedule checkpoints or rotate context.

The missing prerequisite is a reliable, exact-prompt cache-restore probe. Last-turn cache statistics do not prove a future prompt can be restored. The policy distinguishes RAM/SSD restore, warm idle checkpoint, valid checkpoint resume, and unattended deferral. Unknown cache state never authorizes a destructive rotation. A checkpoint that omits important newer work is not eligible for cold resume.

Existing heartbeat configuration remains independent. No heartbeat settings are changed by installing this feature.
