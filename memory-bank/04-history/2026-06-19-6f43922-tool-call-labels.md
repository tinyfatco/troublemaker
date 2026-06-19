# 2026-06-19 6f43922 Tool Call Labels

## Commits

- `6f43922ba4277b052367f5c877335b11c7195c09` (`troublemaker`) - `fix: surface model tool call labels`

## Summary

- Promoted model/tool-supplied per-call labels to first-class `toolCall.label`
  metadata in Troublemaker runtime events, live assistant snapshots, edge
  session snapshots, and web chat stream normalization.
- Kept backwards compatibility with legacy `arguments.label` so existing
  awareness history and MCP/tool calls still render human labels instead of raw
  tool names.
- Updated the web UI display helper so the title prefers the explicit tool-call
  label and the subtitle remains the operational argument, such as a path,
  command, query, or message preview.
- Fixed `send_message` subtitles to preview `text`, `body`, `message`, or
  `content`, and to render `email-thread:*` targets as `Email thread`.

## Verification

- Local Mac, `troublemaker`:
  - `npx tsx test/web-ui-tool-display.test.ts && npx tsx test/web-chat-stream-reducer.test.ts` passed.
  - `npm run typecheck` passed.
  - `npm run build` passed.
  - `cd ui && npm run build` passed with the existing Vite chunk-size warning.
- Server `tiny-bat`, `troublemaker`:
  - `npx tsx test/web-ui-tool-display.test.ts && npx tsx test/web-chat-stream-reducer.test.ts` passed.
  - `npm run typecheck` passed.
  - `npm run build` passed.
  - `cd ui && npm run build` passed with the existing Vite chunk-size warning.

## Manual QA Gaps

- Did not deploy Crawdad/Worker assets in this commit. The change is ready for
  the next Troublemaker/Crawdad runtime deploy path when Alex wants it live.
