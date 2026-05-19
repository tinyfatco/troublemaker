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
Peekaboo
  stdio MCP child process via `peekaboo mcp --no-remote`
Troublemaker.app
  macOS TCC owner for Screen Recording and Accessibility
```

## Install Peekaboo

```bash
brew install steipete/tap/peekaboo
```

Peekaboo is the local Mac automation provider. Troublemaker starts it as a
stdio MCP child process in `--no-remote` mode, so Screen Recording and
Accessibility belong to the app that launches Troublemaker instead of a
separate Peekaboo daemon.

For real computer use, macOS must grant `Troublemaker.app` access to:

```text
System Settings -> Privacy & Security -> Accessibility
System Settings -> Privacy & Security -> Screen & System Audio Recording
```

## LaunchAgent Note

The old LaunchAgent path is useful for server-only testing, but the Mac
automation path should launch through `Troublemaker.app` so TCC grants stick to
the stable app bundle.

## Start Troublemaker

```bash
./run-dev.sh
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
TROUBLEMAKER_PORT=3003 ./run-dev.sh
TROUBLEMAKER_WORKSPACE="$HOME/Troublemaker" ./run-dev.sh
PEEKABOO_MCP_COMMAND=/opt/homebrew/bin/peekaboo ./run-dev.sh
PEEKABOO_MCP_ARGS="mcp --no-remote" ./run-dev.sh
```

## Doctor

```bash
npm run doctor:local-mac
npm run smoke:mac-app
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
