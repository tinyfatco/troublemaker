# Personal VM Computer bridge

## Goal

Keep Computer's global shortcuts, microphone capture, transcription, overlay, and speech playback on the host while making a Troublemaker process inside the personal Tart VM the canonical agent runtime.

The guest owns the agent workspace, session, memory, tool execution, compaction, and computer-use process. The host is only a native input and presentation client. Ricky and the right-Option route remain unchanged. The VM uses Computer's separate left/secondary route.

## Topology

```text
Host Computer (left Option + Shift)
  -> http://127.0.0.1:3028/api/v2
  -> authenticated SSH local forward
  -> guest 127.0.0.1:3018
  -> guest Troublemaker web adapter and canonical workspace

Guest provider traffic
  -> guest http://127.0.0.1:8013/v1
  -> existing personal inference tunnel
  -> host oMLX 127.0.0.1:8011
```

Computer already implements the required portable protocol through `TroublemakerAgentTransport`:

- a completed host transcription becomes one stable-delivery-ID `POST /api/v2/agents/:id/messages` request;
- the guest returns admission, streamed assistant text, bounded tool activity, context transitions, and completion over SSE;
- Computer reconciles interrupted requests by exact delivery ID rather than by resending equivalent text;
- the awareness stream reconnects independently from the active response stream.

No second agent protocol or microphone emulation is required for the first implementation.

## Custody and isolation

- The guest gateway binds only to guest loopback.
- The host sees it only as host loopback through an SSH tunnel using the existing dedicated personal-VM key.
- A separate random bearer token authenticates Computer to the guest's complete `/api/v2` console boundary. The token is stored in mode-0600 files on both sides and never embedded in a plist, command line, URL, log, or workspace. `/health` remains a content-free unauthenticated readiness probe.
- Computer uses a route-specific session ID and delivery ledger. It must never silently fall back to the host agent after an ambiguous remote delivery.
- The guest uses an isolated `PI_AGENT_DIR` and a fresh workspace. Host agent context and Larry content are not copied.
- Larry's runtime, context, credentials, and files remain untouched. Only Computer's left Option + Shift destination changes, with the prior target settings retained for rollback.

## Voice path

Phase one keeps STT on the host:

1. Computer captures the physical microphone and renders partial text locally.
2. At end of utterance, Computer submits the final transcript to the guest using the existing message contract.
3. The guest executes one canonical agent turn.
4. Computer renders streamed text and tool activity and may perform host-side speech playback according to the guest's bounded client preference.
5. In Computer call mode, the first finalized utterance uses `computer_voice_call_started`; later utterances use `computer_voice_call_turn`. Troublemaker adds hidden call/steering instructions while preserving the exact human transcript. The same canonical agent receives ordinary turns, call turns, heartbeats, tools, and continuation events. Computer remains the speaking layer and must not invoke a second runtime speech tool.

This creates an explicit thinking/speaking split: the guest's configured agent model owns reasoning, memory, tools, heartbeats, and steering, while the host owns microphone capture, transcription, sentence-level synthesis, playback, and interruption. This avoids a virtual microphone, guest microphone TCC, and raw-audio retention. A later optional mode can use the existing `computer.voice-session.v1` contract to stream mono 16 kHz PCM to guest-owned STT without changing agent delivery semantics.

## Context policy for the local vision model

The guest starts with the compact prompt/tool profile and a declared 65,536-token operational context ceiling. That is intentionally below the checkpoint's 262K technical maximum so compaction occurs before interaction becomes thermally and operationally impractical.

The existing `TROUBLEMAKER_INPUT_BUDGET=small` profile is not enabled initially because it omits all non-text attachments and would remove computer screenshots. A vision-aware policy is still required:

- preserve explicit tool provenance for screenshots;
- never treat a tool-generated image as a fresh human request;
- retain only the latest task-relevant screenshot in active provider context;
- bound accessibility-tree and other textual observations, with detail retrievable on demand;
- preserve immutable provider projections where prefix-cache correctness requires them.

Until Pi's OpenAI-compatible adapter can carry multimodal tool content directly, its synthetic user-role image caption must explicitly state that the image is tool output and not evidence of a repeated request, urgency, or user sentiment.

## Deployment

Guest:

- runtime support root: `~/Library/Application Support/PersonalTroublemakerBridge`
- workspace: `~/Library/Application Support/Troublemaker/Agents/personal-vm/Workspace`
- loopback gateway: `127.0.0.1:3018`
- LaunchAgent: `com.tinyfatco.troublemaker-personal-vm`

Host:

- tunnel support root: `~/Library/Application Support/PersonalTroublemakerBridge`
- forwarded endpoint: `127.0.0.1:3028`
- LaunchAgent: `com.tinyfatco.personal-troublemaker-tunnel`
- Computer secondary target: `http://127.0.0.1:3028`, agent `personal-vm`, activated by left Option + Shift

The Computer left/secondary route is switched only after guest health, authenticated discovery, and the SSH forward are verified. Starting the idle gateway does not submit an inference request. Interactive acceptance waits until the standalone Pi benchmark is no longer using oMLX.

## Acceptance criteria

1. Health remains available through the loopback tunnel, while every `/api/v2` request without the bridge credential receives `401`.
2. Authenticated agent discovery identifies only `personal-vm`.
3. One host transcript creates exactly one guest delivery ID and one durable user turn.
4. Stream interruption reconciles by delivery receipt without duplicate inference.
5. Guest-local computer use controls only guest applications.
6. Tool labels and compaction events appear in host Computer.
7. Stopping the VM produces a clear unavailable state, never host-agent fallback.
8. Right Option remains on Ricky. Larry's runtime and data remain untouched, and only the left Option + Shift target is replaced.
