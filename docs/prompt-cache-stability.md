# Stable prefixes and runtime context

The resident runner keeps route-dependent metadata out of the system prompt.
Every incoming message carries its own current channel, user map, and delivery
policy in `session_context`. Switching channels therefore appends new input
rather than rewriting the prefix of the complete conversation.

Skills and workspace context are carried in a hidden `runtime-context` custom
message. A snapshot is appended only if its content changed or the latest
snapshot is absent from the actual model history. Existing snapshots and messages
are never edited in place. The extension runs after pre-turn compaction and reads
the model's actual history, so session restoration, compaction, and bounded history
projection cannot leave the model depending on a snapshot it no longer sees.
The latest snapshot supersedes earlier workspace state.

This avoids a growing copy of unchanged workspace context on every turn while
preserving an append-only provider prefix. A changed model, changed base
instructions/tools, fresh context, or compaction may still invalidate a provider
cache. Cache retention, capacity, and restart persistence remain inference-server
responsibilities; the runner does not promise that every request is a cache hit.

`pnpm test:context-pressure` covers stable system/history bytes across route
changes, current delivery policy, changed workspace snapshots, session restore,
and removal of a snapshot by real session compaction.
