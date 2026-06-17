# 2026-06-17 - 125248c - Web chat turn preservation

## Commits

- `125248c` (`troublemaker`): Preserve interrupted web chat turns.
- Related Flight commit: `54d0eb8` streams and persists Flight console ledger turns.

## What Changed

- Added a shared `WEB_CHAT_TURN_COMPLETE_EVENT`.
- `useWebChat` now preserves the current optimistic user and assistant turn into local entries before a normal or steering request replaces the single active stream slot.
- `useAwarenessStream` refreshes recent durable backlog when a web chat turn completes, including stale requests that finish after a newer request becomes active.
- `mergeOptimisticEntries` now filters local fallback entries when equivalent durable user or assistant entries exist.
- Added regression coverage for completion refresh wiring, steering replacement, interrupted local turns, and durable dedupe.

## Verification

- `npm run test:web-ui-turn-complete-refresh`
- `npm run test:web-ui-optimistic-dedupe`
- `cd ui && npm run build`
- Browser QA through Flight/Floopy using the deployed bundle `index-DS48d93i.js`:
  - Rapid send kept the first visible turn after the second request replaced the active stream slot.
  - Refresh check confirmed the final markers were still present via Flight `/events`.

## Deploy Status

- Source pushed to `tinyfatco/troublemaker` at `125248c`.
- UI bundle deployed through Crawdad Worker assets in version `d7cfcde0-ca6e-404a-8f1a-a1ab29777e5c`.
- Flight shell deployed separately at Worker version `0a5ce80e-c52a-4935-99f2-37f61d1b60fc` to reference the new bundle.

## Manual QA Gaps

- Existing unrelated dirty files remained in the local `troublemaker` worktree and were not staged.
- The current UI still has one active network stream slot; this patch preserves the replaced visible turn locally and dedupes it when durable rows arrive, but does not make simultaneous turns fully independent.
