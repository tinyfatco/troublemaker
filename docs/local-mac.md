# Local Mac Runtime

This profile runs Troublemaker as a local Mac agent runtime and lets native
voice tools send final utterances into the agent over a local webhook.

## Shape

```text
Local voice tool
  POST /input/webhook
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

For an always-on host agent whose shell already has the required Peekaboo TCC
grants, `scripts/install-ghost-mac.sh` installs two user LaunchAgents: the Ghost
runtime and a loopback-only reverse SSH relay to tiny-bat. Ghost listens only on
the Mac loopback interface and uses Slack Socket Mode plus Telegram polling;
tiny-bat terminates the authenticated `ghost.tinyfat.com` route.

## Start Troublemaker

```bash
./run-dev.sh
```

Defaults:

```text
UI:        http://127.0.0.1:3002
Webhook:   http://127.0.0.1:3002/input/webhook
Workspace: ~/Library/Application Support/Troublemaker/Workspace
Model:     fireworks/accounts/fireworks/models/glm-5p2
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

## Realtime Voice WebSocket

For integrated voice, connect your app to:

```text
ws://127.0.0.1:3002/voice/realtime
```

Protocol:

1. Send `{ "type": "start", "voice": "marin" }` as JSON.
2. Stream mono PCM16 little-endian 24kHz microphone audio as binary frames.
3. Receive binary mono PCM16 24kHz assistant audio plus JSON status/transcript events.
4. Send `{ "type": "interrupt" }` to barge in or `{ "type": "stop" }` to close.

OpenAI Realtime is only the audio transport: STT/VAD in, speech out. Final
transcripts enter Troublemaker's canonical Zip runtime, so voice uses the same
AgentRunner, memory, tools, awareness, and persistence as web/email/SMS.

## Input Webhook Payload

The older local webhook path still accepts finalized transcripts when an
external STT tool owns audio capture:

```text
http://127.0.0.1:3002/input/webhook
```

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
