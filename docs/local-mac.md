# Local Mac Runtime

This profile runs Troublemaker as a local Mac agent runtime and lets native
voice tools such as Yappatron send final utterances into the agent over a local
webhook.

## Shape

```text
Yappatron
  POST /input/yappatron
Troublemaker
  web adapter, memory, tools, web UI
Clawd Cursor
  HTTP MCP body at 127.0.0.1:3847/mcp
```

## Start Clawd Cursor

```bash
npm run local:mac
```

`npm run local:mac` starts Clawd Cursor automatically when `127.0.0.1:3847`
is not already healthy. To run it manually:

```bash
scripts/start-clawdcursor-mcp.sh
```

To install both Clawd Cursor MCP and Troublemaker local as user LaunchAgents:

```bash
npm run install:local-mac
```

The local MCP token is expected at:

```text
~/.clawdcursor/token
```

Clawd Cursor also runs a native macOS host at `127.0.0.1:3848`. For real
computer use, macOS must show `ClawdCursor` as enabled in both:

```text
System Settings -> Privacy & Security -> Accessibility
System Settings -> Privacy & Security -> Screen & System Audio Recording
```

## Start Troublemaker

```bash
npm run local:mac
```

Defaults:

```text
UI:        http://127.0.0.1:3002
Webhook:   http://127.0.0.1:3002/input/yappatron
Workspace: ~/Library/Application Support/Troublemaker/Workspace
Model:     fireworks/accounts/fireworks/models/glm-5p1
```

`npm run local:mac` loads `FIREWORKS_API_KEY` from macOS Keychain service
`com.tinyfatco.troublemaker.local` when it is not already present in the
environment.

Override with:

```bash
TROUBLEMAKER_PORT=3003 npm run local:mac
TROUBLEMAKER_WORKSPACE="$HOME/Troublemaker" npm run local:mac
CLAWDCURSOR_MCP_URL=http://127.0.0.1:3847/mcp npm run local:mac
CLAWDCURSOR_AUTOSTART=0 npm run local:mac
```

## Doctor

```bash
npm run doctor:local-mac
```

## Yappatron Webhook Payload

In Yappatron, enable **Send Final Utterances to Webhook** and use:

```text
http://127.0.0.1:3002/input/yappatron
```

Yappatron can post a final utterance to `/input/yappatron`:

```json
{
  "event_type": "yappatron.utterance.v1",
  "event_id": "uuid",
  "session_id": "uuid",
  "source": "yappatron-mac",
  "text": "open Chrome and search for tiny fat",
  "is_final": true,
  "timestamp": "2026-05-19T12:00:00Z"
}
```

Troublemaker maps that into the web adapter as a `voice` channel prompt and
returns `202 Accepted` immediately.
