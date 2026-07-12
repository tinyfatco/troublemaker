# Local Mac Runtime

This profile runs Troublemaker as a local Mac agent runtime and lets native
voice tools send final utterances into the agent over a local webhook.

## Shape

```text
Local voice tool
  POST /input/webhook
Troublemaker
  web adapter, memory, tools, web UI
Codex Computer Use
  bundled `SkyComputerUseClient mcp` stdio child process
SkyComputerUseService
  macOS accessibility and application-control backend
```

## Install Computer Use

Computer Use is bundled with Codex.app. Troublemaker starts the bundled
`SkyComputerUseClient` through the signed Codex sandbox launcher as a stdio MCP
child process with the plugin directory as its working directory. The signed
parent authenticates the client to `SkyComputerUseService`; launching the client
directly exposes its tool catalog but causes live calls to fail with sender
authentication errors. Computer Use replaces Peekaboo for Mac host agents.

For real computer use, macOS must grant the Codex Computer Use service access to:

```text
System Settings -> Privacy & Security -> Accessibility
System Settings -> Privacy & Security -> Screen & System Audio Recording
```

## LaunchAgent Note

The old LaunchAgent path is useful for server-only testing, but the Mac
automation path should launch through `Troublemaker.app` so TCC grants stick to
the stable app bundle.

For an always-on host agent with a healthy Codex Computer Use service,
`scripts/install-ghost-mac.sh` installs two user LaunchAgents: the Ghost
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
COMPUTER_USE_PLUGIN_DIR="/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use" ./run-dev.sh
COMPUTER_USE_MCP_COMMAND="/absolute/path/to/SkyComputerUseClient" ./run-dev.sh
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
