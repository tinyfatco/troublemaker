# Current Work

**Last updated:** 2026-05-18

## Status: Hosted Workspace Reliability Polish In Progress

2026-05-18: Active work is on the Crawdad-hosted Troublemaker workspace
inside the fat-platform iframe. The immediate target is GitHub issues #21
and #22:

- #21: keep the active streaming message visible when the user is already
  near the live bottom, and compensate when the input composer expands so it
  does not hide the newest agent output.
- #22: completed tool calls should render as green/success; yellow/orange
  should be reserved for running/pending tool activity.

Implementation note: this belongs in `troublemaker/ui`, because Crawdad CF
serves the built workspace UI bundle. The fix tracks the composer height,
keeps a live scroll signal for streaming content growth, respects explicit
manual scroll-up, and makes completed tool-call groups/rows use the success
palette by default.


## Status: Phone Messaging Adapter Added

2026-05-11: Added the provider-neutral `phone` adapter for SMS/iMessage-style threads. It accepts canonical phone webhook payloads, records discovered `phone-...` channels, replies via LoopMessage or Twilio provider drivers, and exposes those channels through `list_channels` / `send_message_to_channel`.

This is explicitly a two-way conversational surface, not cold outbound broadcast infrastructure. Loop group-chat and iMessage-to-SMS fallback behavior still requires sandbox QA before customer use.

2026-05-11 follow-up: phone receipt/status payloads with `direction=outbound` are logged but do not enter the agent event loop. This defends against Loop delivery callbacks echoing Zip's own outbound iMessages back as fresh inbound user messages.

## Status: Self-Hosted Runtime Is Real

### Native Terminal PTY — Shipped

`node-pty` + WebSocket upgrade handler in `src/terminal.ts`. Gateway registers `UPGRADE /terminal` route. Works standalone and through crawdad-cf. UI hooks updated to connect to gateway port instead of requiring sandbox terminal proxy.

### Ghost — Standalone Agent on Tiny-Bat

Proof of concept for self-hosted troublemaker:
- Git worktree at `~/troublemaker-ghost` (branch `ghost-dev`)
- Data at `~/ghost-data` with `settings.json` + `MEMORY.md`
- Running Kimi K2.5 via Fireworks API (`FIREWORKS_API_KEY`)
- ElevenLabs voice working (voice ID `qA5SHJ9UjGlW2QwXWR7w`)
- 28ms startup. Terminal, web chat, voice, awareness stream all functional.
- Auth: SSH tunnel. No tokens needed. Gateway trusts localhost.
- Heartbeat running — Kimi autonomously doing background work.

### Message Dedup — Fixed After 3 Iterations

The web chat had a persistent duplication bug: optimistic entries (shown immediately) overlapped with SSE entries (from context.jsonl). Three attempts:
1. ID dedup on SSE insert — caught reconnections but not optimistic overlap
2. Clear optimistic on complete — caused visible flash
3. **Final:** `showStreaming` flag. Streaming entry stays visible until SSE delivers an assistant entry with timestamp >= streaming timestamp, then yields. No flash, no duplication. Voice and cross-channel messages pass through unfiltered.

### UI Polish — Shipped

- Timestamps in meta row (top-left)
- Flat card styling (2px radius, minimal padding)
- Assistant cards with background + border
- Tool calls: `→ label` format matching Telegram/Slack
- Table formatting for markdown tables
- Loading screen: `#1a1a1a`, spinner on top, "Waking up..."

### Next P0: Real-Time Awareness Stream

SSE polls context.jsonl on an interval — noticeable delay between agent work and UI update. Need `fs.watch` push or sub-second polling for real-time feel. Critical for heartbeat/spontaneity where agent works in background.

## Architecture

- **Gateway:** HTTP server on configurable port (default 3002). Serves static UI, REST endpoints, SSE stream, WebSocket upgrade for terminal.
- **Voice:** Dedicated WebSocket server on port 8766. Vite dev server proxies `/voice/stream` there.
- **Adapters:** web, telegram, slack, discord, email, heartbeat, web-voice. Each independent.
- **Sandbox modes:** `host` (bare metal, tools run directly) or `docker:<name>` (isolated).

## Upstream

Pi agent core `@mariozechner/pi-agent-core@0.58.4`. 1M context for Claude 4.6. Models: Kimi K2.5 (Fireworks), Claude Sonnet 4.6, GPT-5.4 (Codex OAuth — currently rate-limited).
