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

The Computer Use MCP server uses MCP form elicitation for its per-app approval
gate. Troublemaker advertises that capability only to the local stdio server
configured as `computer-use`, and auto-accepts only the server's empty
`Allow ChatGPT to use ...?` form with persistent-app metadata. Other MCP
elicitations fail closed. `doctor-local-mac.sh` verifies the complete path by
reading Finder's accessibility tree and screenshot, not merely listing tools.

For real computer use, macOS must grant the Codex Computer Use service access to:

```text
System Settings -> Privacy & Security -> Accessibility
System Settings -> Privacy & Security -> Screen & System Audio Recording
```

## LaunchAgent Note

The old LaunchAgent path is useful for server-only testing, but the Mac
automation path should launch through `Troublemaker.app` so TCC grants stick to
the stable app bundle. Keep any deployment-specific LaunchAgent definitions,
tunnels, hostnames, ports, and adapter credentials in a private operations
repository.

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

## Compaction cue

On macOS, Troublemaker plays a quiet built-in system sound when context
compaction begins. Playback is best-effort and never blocks the agent. Set
`MOM_COMPACTION_SOUND=off` to disable it, use an absolute audio-file path to
replace it, or tune `MOM_COMPACTION_SOUND_VOLUME` between `0` and `1`.

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

Initial attention uses `hey <agent name>`, where the name comes from the
workspace `IDENTITY.md` `Name:` field. The wake prefix is removed from the
canonical turn; natural follow-ups remain open until the session closes or the
user says an exact voice-off control. Supported Realtime voices can be changed
with an exact spoken control such as `switch voice to cedar`.

A committed utterance interrupts assistant audio immediately. If canonical work
is already active, the transcript waits FIFO as a fresh turn and starts only
after a safe completion boundary; it never aborts the active tool/run. Non-voice
busy messages soft-steer the active model at its next safe boundary, falling
back to a queued fresh turn without aborting active work.

OpenAI Realtime is only the audio transport: STT/VAD in, speech out. Final
transcripts enter Troublemaker's canonical agent runtime, so voice uses the same
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

Busy webhook transcripts interrupt and restart the active run by default. An
agent can change that behavior with `self_configure` setting
`voice.webhook_input_mode` to `steer`; steering appends to an accepting model
turn and otherwise queues a fresh turn without aborting active work. Set it
back to `interrupt` to restore replacement behavior.

## Explicit SAG Speech

On macOS, the explicit `speak` tool can use
[`sag`](https://github.com/superpower-chat/sag). Set `speak.backend` to `sag` in
`settings.json`; ordinary final responses are not spoken automatically.

The default SAG invocation is equivalent to:

```bash
/opt/homebrew/bin/sag --model-id eleven_flash_v2_5
```

When the `speak` tool is called, Troublemaker sends speech text over stdin and launches SAG through a login Zsh,
so an operator-approved ElevenLabs environment can load without copying API
keys into `settings.json` or command-line arguments. Override the executable,
model, or shell with `settings.json` under `speak.sag`, or with
`MOM_SPEAK_SAG_COMMAND`, `MOM_SPEAK_SAG_MODEL_ID`, and
`MOM_SPEAK_SAG_SHELL`.
