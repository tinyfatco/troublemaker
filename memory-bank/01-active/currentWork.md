# Current Work

**Last updated:** 2026-05-22

## Status: Pi Distribution Migration Queued

2026-05-22: TroubleMaker still depends on the deprecated
`@mariozechner/pi-*` npm distribution. The next runtime-maintenance slice
should move to the Earendil Works distribution of Pi before upstream drift gets
more expensive. This was intentionally left out of the workspace UI reliability
deploy because catching up the Pi API surface may require broader runtime
refactoring and focused validation.

Near-term scope:

- Identify the current Earendil Works Pi package names and migration notes.
- Update TroubleMaker imports/dependency pins and any changed event/tool-call
  streaming API shapes.
- Re-run web chat, adapter, model-selection, and hosted workspace smoke tests
  before baking into Crawdad.

## Status: Hosted Workspace Reliability Polish In Progress

2026-05-22: Follow-up reliability slice shipped the Zip PR for
`yield_no_action` reason subtext and extended tool-card subtext to
`send_message_to_channel` / `send_message` calls so outbound messages show the
target plus message preview. It also forwards Pi `toolcall_delta` /
`toolcall_end` events through web SSE so tool-call arguments stream into the
workspace UI, dedupes active optimistic tool cards once durable awareness
covers the same tool id, and makes bottom-pin state respect explicit upward
scroll intent.

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

2026-05-18 follow-up: #23 targets thinking display. The UI no longer hard
truncates thinking blocks at 80 characters with appended ellipses. Medium
thinking text renders intact; only genuinely long thinking content collapses
to a larger 600-character / 8-line preview, with the full text available by
expanding.

2026-05-18 follow-up: #24 tracks a warm-path repeated slash-command render
bug found by the hosted Playwright regression. The backend returned the second
`/model` response, but optimistic dedupe treated the recently completed
identical prior turn as the current turn and hid the new streaming response.
The fix narrows the optimistic match skew so rapid repeated turns remain
visible.

Second #24 fix: the frontend could also route a rapid repeated slash command
through the steering path if the previous request was still winding down.
Slash commands should always use the normal independent send path because the
backend explicitly bypasses busy handling for them.

Third #24 fix: the backend web adapter no longer relies only on a single
mutable `channelId -> SSE writer` slot for slash-command responses. Each
incoming web request now carries a request-scoped SSE writer through
`AsyncLocalStorage`, so overlapping same-channel slash commands cannot steal
or drop each other's final text. Added a regression that runs `/slow` and
`/fast` concurrently and asserts each response lands on its own stream.

Fourth #24 fix: the web UI now keeps completed slash-command turns in a
small local transcript buffer. `/model` and similar commands do not always
write assistant entries to `awareness/context.jsonl`, so the previous
single-entry optimistic state caused repeated slash commands to replace the
prior visible response instead of adding a new one. Added optimistic merge
coverage for completed local slash history followed by a repeated live
response.

Warm-path performance follow-up: hosted Playwright now proves the repeated
`/model` response renders twice, but warm response time was still ~7.9s.
The remaining delay was inside `/model` itself: the no-args command rebuilt a
full `ModelRegistry` just to display the current provider/model. Added a fast
current-selection reader for `/model` no-args while leaving registry-backed
resolution for `/model list` and `/model <name>`.

Container warm-after-cold follow-up: hosted traces showed the second `/model`
request reached `/web/chat` quickly after the Crawdad CF fast path, but the
container delayed the first SSE chunk while the startup event watcher scanned
and registered existing scheduled events. The watcher now arms filesystem
watching immediately for new event files but delays its initial existing-file
scan by 10s after boot, giving the first warm web turn a clear path before
background scheduling work starts. Added `test:events-initial-scan-delay`.
Verified after baking into `CRAWDAD_VERSION=254`: hosted cold/warm Playwright
passed, with warm `/model` at ~3.2s immediately after the cold turn. Cold
remains ~30s because sandbox filesystem/process readiness still dominates
before the Troublemaker gateway can accept `/web/chat`.

Small visual follow-up: the streaming cursor placeholder now only appears
while an assistant streaming entry has no visible content. As soon as text,
thinking, or tool activity arrives from SSE, the placeholder is replaced by
the real streaming content instead of remaining as a separate blinking block.

Top-bar polish follow-up: the workspace header no longer renders the last
awareness event time beside the connection dot. That value was the timestamp
of the most recent delivered agent event, not a useful clock, so the header
now only exposes connected/loading/reconnecting status.

Dark-mode link polish: markdown links now get a lighter dark-theme color for
normal, visited, and hover states so URLs in chat are readable without
changing light-mode rendering.

2026-05-18 follow-up: #25 keeps bottom tool-call accordion expansion visible
by re-anchoring the awareness pane only when the user was already following
the live bottom. #26 replaces the empty streaming cursor placeholder with a
compact spinner. #27 tightens the web SSE writer lookup and optimistic merge
logic so tool-call activity can remain visible while a tool-first response is
still streaming.

Spinner polish follow-up: the pending assistant spinner is no longer rendered
inside the generic awareness-entry card surface. It now appears as a bare
inline waiting indicator in the stream.


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
