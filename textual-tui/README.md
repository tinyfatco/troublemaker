# Troublemaker Textual terminal

A [Textual](https://textual.textualize.io/) client for a Troublemaker agent's
canonical console session. It speaks the same console API as
`troublemaker-tui` and reads the same installed profiles
(`~/.config/troublemaker/tui.json`), so any agent installed with
`troublemaker-tui install` opens here too.

```sh
cd textual-tui
uv sync
uv run troublemaker-textual <agent>       # an installed profile
uv run troublemaker-textual list
uv run troublemaker-textual --url http://127.0.0.1:3000 --name Example
uv run troublemaker-textual <agent> --thinking   # stream model reasoning
```

## What it shows

- **One transcript, in order.** Terminal input, other channels (Slack, Zulip,
  email…), ambient context, follow-up and heartbeat wakes, and the agent's
  replies interleave chronologically, each exactly once.
- **Live streaming.** Replies stream in as Markdown and append in place
  instead of re-rendering.
- **Expandable tool calls.** Each call is one line with a state glyph, live
  timer, duration and exit status. Click it, or press `ctrl+t` then `↑↓` and
  `enter`, to expand the server's bounded, redacted detail: input, streamed
  stdout/stderr, output, and artifacts. `ctrl+e` or `/tools` expands all.
- **Steering.** Typing while the agent works steers the active turn. Its
  output continues below your new message, and tool rows stay where they
  started and update in place.
- **Status.** A single status line shows thinking, writing, working,
  compaction (with elapsed time) and queued input. Context handoff and
  compaction receipts update in place.
- **Commands.** `/` autocompletes. Local commands: `/help /stop /tools
  /collapse /thinking /reload /status /quit`. Agent commands `/model /context
  /compact /clear /voice /login /cancel` go to the agent. `ctrl+p` opens the
  command palette, including theme switching.

Keys: `enter` sends, `shift+enter` / `ctrl+j` inserts a newline, `↑↓` moves
through history, `esc` stops, `ctrl+c` stops then quits, and `ctrl+d` quits
when the input is empty.

## Design

```
client.py      async HTTP + SSE for /status, /events, /live, /messages
protocol.py    pure port of the TS display rules (envelopes, ambient, deltas)
transcript.py  pure reconciliation model: events in, ordered keyed items out
widgets.py     one widget per item, refreshed in place by key
markdown.py    assistant text as one widget, rendered and cached per block
app.py         layout, input, loops; batches repaints to one per frame
```

The transcript model has no UI dependency. Local echoes, runtime
`user_input`, live snapshots and durable awareness lines all reconcile into
an append-only list of keyed items. The view only ever mounts a widget or
refreshes one by key, which is what keeps the screen still while the agent
streams. `tests/test_transcript.py` pins the reconciliation behavior.

Performance rule: every layout pass walks every mounted widget, so the tree
stays small. Each assistant text part is one widget (Rich Markdown rendered to
selectable text, cached per block so streaming re-renders only the last
block), fixed one-line rows repaint without a layout pass, and at most
`MAX_MOUNTED` transcript items stay mounted.

Tool detail comes only from the server's sanitized `displayDetails`
projection (the `pi` presentation). Raw tool payloads never reach the
terminal.

## Development

```sh
uv run pytest            # protocol, transcript and headless app tests
TUI_SCREENSHOT_DIR=/tmp/shots uv run pytest tests/test_app.py   # SVG screenshots
```
