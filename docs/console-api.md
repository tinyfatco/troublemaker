# Agent Console API

The console API is the portable contract between the workspace UI and an agent
runtime.

Two implementations should satisfy this contract:

- Crawdad CF: hosted agents, Supabase auth, Cloudflare Containers, R2/DO state.
- Troublemaker standalone: one agent on a VPS, local auth/reverse proxy, local files.

The UI should not call container-private routes directly. Container routes such
as `/awareness/stream`, `/api/files`, `/api/file`, `/api/upload`, and
`/web/chat` are implementation details behind this contract.

## Routes

All routes are same-origin from the console UI.

```text
GET  /api/v2/session
GET  /api/v2/agents
GET  /api/v2/agents/:id/status
GET  /api/v2/agents/:id/deliveries?ids=:delivery-id,...
GET  /api/v2/agents/:id/events?limit=50&before=:offset
GET  /api/v2/agents/:id/events/stream
GET  /api/v2/agents/:id/live
POST /api/v2/agents/:id/messages
POST /api/v2/agents/:id/messages/stop
POST /api/v2/agents/:id/transcriptions
POST /api/v2/agents/:id/voice-sessions
GET  /api/v2/agents/:id/voice-sessions/:session-id/events?after=:sequence
POST /api/v2/agents/:id/voice-sessions/:session-id/events
POST /api/v2/agents/:id/voice-sessions/:session-id/speech-controls
POST /api/v2/agents/:id/device-grants
DELETE /api/v2/agents/:id/device-grants/:grant-id
GET  /api/v2/agents/:id/files?path=:path
GET  /api/v2/agents/:id/file?path=:path
PUT  /api/v2/agents/:id/file
POST /api/v2/agents/:id/upload
```

For Troublemaker standalone, `:id` may be `current`. Hosted Crawdad uses the
real agent UUID or name.

Hosted Crawdad also exposes control routes on the same `/api/v2` boundary:
`POST /api/v2/list`, `POST /api/v2/agents/:id/message`,
`POST /api/v2/agents/:id/configure`, `POST /api/v2/agents/:id/assign`,
`POST /api/v2/agents/:id/stop`, and `POST /api/v2/agents/:id/restart`.
Secret writes go through `configure` with either `target: "secrets.<key>"` or
`target: "secrets"` plus an object value. Crawdad stores those values in
`encrypted_secrets_v2`; responses return secret names only.

## Auth

Crawdad CF accepts:

- Supabase browser session cookies for the hosted web console.
- `tfat_oauth_*` Bearer tokens for OAuth/MCP/mobile clients.
- `tfat_live_*` Bearer tokens for API clients.

Troublemaker standalone currently assumes same-origin access and should be run
behind a local tunnel, reverse proxy auth, or a future standalone console token.

A host-owned standalone console facade may additionally issue a revocable,
device-bound grant to a native client. Grant enrollment requires the existing
owner Bearer credential and a P-256 proof generated on the target device. The
returned descriptor contains no owner credential or provider key. Subsequent
requests use `Authorization: DeviceGrant <grant-id>` plus a signature over the
exact method, path and query, timestamp, nonce, content type, body digest, and
agent subject. New native grants may additionally bind a closed `mac`, `iphone`,
or `watch` surface in the signed enrollment proof. Grants are scoped, expire,
bind to one exact route and subject, and reject stale timestamps or replayed
nonces. The facade must remain a narrow
allowlist in front of a loopback runtime and strip device and owner authority
before forwarding. Device-grant routes are optional host integration; they do
not weaken or replace existing console authentication.

## Current State

The v2 console API is the product boundary for hosted web, standalone web, and
future mobile clients. Crawdad CF can satisfy cheap reads and status from the
Worker/R2 side when that is practical, but agent turns are container-backed:
`POST /messages` streams from Troublemaker's `/web/chat` gateway. The Worker is
not an agent runtime.

Fat Platform `/api/v1` is retired. New product integrations should use Crawdad
`/api/v2` with `tfat_live_*` API keys.

## Chat And Event Semantics

`GET /api/v2/agents/:id/status` may include bounded client preferences for the
selected agent. The current shape is:

```json
{
  "client_preferences": {
    "macos_computer_auto_speech": true
  }
}
```

The field defaults to `true` for compatibility. It controls only whether the
macOS Computer client automatically speaks assistant output; it does not
authorize runtime speech and does not change manual speech, Realtime voice,
CallMe, iPhone, Watch, or another channel. The status response exposes this
boolean only, never the raw settings block.

When `capabilities.transcription` is true, an authenticated client may send a
bounded push-to-talk recording to `POST /api/v2/agents/:id/transcriptions`.
The request body is raw mono 16 kHz signed little-endian PCM with
`Content-Type: audio/L16; rate=16000; channels=1` and a stable, non-secret
`X-Transcription-ID`. The response contains only that identity and exact
transcribed text. Transcription does not create an agent turn; the client must
submit the returned text through the normal stable-`deliveryId` message route.
Provider credentials remain host-owned, raw audio is not written to the
workspace, and provider response bodies are never projected through this API.
Successful results are durably reconciled by transcription ID and audio digest:
an exact replay returns the same transcript without another provider call,
while reuse of an ID for different audio fails with `409`. This lets clients
recover from a lost response without guessing or duplicating paid work.

When `capabilities.voice_session` is true, native clients use
`computer.voice-session.v1` through the four `/voice-sessions` routes above.
The open envelope binds one stable session, capture, delivery, and exact subject
agent. Audio events are mono 16 kHz PCM16 chunks with a monotonic client
sequence. Server events are one ordered stream containing flow acknowledgements,
voice activity, cumulative transcript snapshots, exact-once EOU, accepted send,
assistant snapshots, terminal state, and, when requested, completion/stream/
segment-bound mono 24 kHz PCM16 speech. Reconnect uses the last accepted server
sequence; changed replay, gaps, identity changes, acknowledgement regression or
overshoot, and exhausted windows fail closed.

The runtime accepts at most 2,047 audio events and reserves client event 2,048
for EOU or cancel. Capture is limited to 60 seconds and 1.92 MB. Progressive
speech uses at most eight unacknowledged segments, 512 total segments, 120
seconds, and 5.76 MB; acknowledgement controls strictly advance and control 513
remains reserved for cancel. Owner-only bounded replay storage contains the
server outbox and privacy-safe input fingerprints, never raw microphone audio.
Cumulative persisted transcript and assistant snapshots share a 2 MiB budget;
the runtime reserves 16 MiB of durable capacity before admitting each active
session, so every accepted legal session retains room for speech and a terminal
receipt. Terminal eviction is applied identically to disk and live memory while
active sessions are never evicted. Every accepted client, provider-callback,
speech-flow, and terminal transition is staged against a prior snapshot and
becomes live only with its atomic file commit; write or rename failure restores
the exact prior live state, and irreversible provider cleanup runs only after
commit. Canonical work uses a side-effect-free prepare claim: completion and delivery
identity are derived first, `send_accepted` plus closed client input commit
atomically, and only then may the exact idempotent canonical dispatch start. A
cancellation committed before admission suppresses dispatch; cancellation after
admission is rejected. Canonical custody is a durable outbox with `admitted`, `dispatching`,
`completed`, and pre-dispatch `failed` states. Restart safely dispatches only `admitted`;
a recovered `dispatching` state becomes `canonical_delivery_unknown` and is
never blindly repeated. A failed provider terminal write retains a retry-only terminal marker;
poll or exact replay retries that commit without repeating PCM, finalization, or
cleanup. Ambiguous rename errors are classified by exact intended-byte read-back;
a mismatch restores and verifies the exact prior bytes, otherwise the session is
quarantined as durability-uncertain rather than claiming rollback. An interrupted nonterminal session becomes one durable retryable terminal error
on restart rather than blindly resending an unknown canonical turn.

`response_policy` is a closed `standard` or `concise_watch` value. The client
cannot turn that enum into free-form prompt text. The authentication facade
strips any supplied surface header and injects only the surface verified by the
signed device grant. Only a verified Watch grant authorizes `concise_watch`;
all other surfaces authorize `standard`. Provider names, voice identifiers,
credentials, URLs, and provider payloads never enter the device contract.

`POST /api/v2/agents/:id/messages` returns an SSE stream for the active turn.
Clients should treat that stream as the low-latency rendering path for the
message they just sent. Every mutating client supplies a stable `deliveryId`.
If that response stream is lost, clients reconcile the exact ID through the
bounded `/deliveries` lookup and the `deliveryId` on the sanitized durable user
message; they must never infer delivery from body equality or automatically
resend an unknown attempt. Receipts disclose only accepted/completed authority
and timestamps, never message content.

`GET /api/v2/agents/:id/events/stream` emits only new durable awareness lines.
Each SSE message should include an `id` when the backing awareness line has an
`id` or timestamp, allowing browsers to provide `Last-Event-ID` on reconnect.
Clients still need duplicate filtering by parsed awareness entry id.

`GET /api/v2/agents/:id/live?surface=conversation` emits an immediate
non-advancing `cursor` event and repeats cursor heartbeats every 15 seconds, so
quiet connections have an explicit readiness signal without inventing a user
or assistant event.

The conversation backlog includes an additive `awareness` array, and each live
envelope may include the same array alongside its existing `kind`. Native
clients that do not understand awareness remain compatible because their
message and cursor shapes do not change. The current awareness item is a
strictly bounded tool lifecycle:

```json
{
  "id": "tool-example",
  "timestamp": "2026-01-01T00:00:00Z",
  "kind": "tool",
  "label": "Checking the workspace",
  "state": "started"
}
```

`state` is `started`, `completed`, or `failed`. The stable tool-call ID is the
only reconciliation authority across live replay and durable history. Labels
are bounded human-readable progress labels; tool names, arguments, output,
results, thinking, terminal data, and runtime routing never enter the mobile
contract. Awareness is operational presentation, never assistant text or
speech-eligible content.

Durable user messages may also include `awarenessKind` with `heartbeat`,
`goal_continuation`, or `follow_up`. Classification comes only from the
runtime-owned channel or delivery provenance. Follow-up projection removes its
private reply target and internal harness instructions before serialization;
arbitrary user text that resembles a marker is not reclassified.

The durable event stream remains the source of truth. Optimistic chat entries
are UI affordances, not persistent state.

User conversation messages and runtime `user_input`/`steering_input` entries
may include `displayName` and `userId`. `userName` retains the transport's
original identifier, including opaque usernames; `userId` retains the exact
transport ID as a string. Clients may prefer `displayName` for attribution and
fall back to their existing `userName` label when it is absent.

Display attribution comes only from a verified ingress snapshot. The runtime
stores `senderIdentity` metadata (`source: "verified_ingress"`, `userId`,
`userName`, `displayName`) on the exact canonical user message, outside model
text. Authenticated Zulip ingress supplies this snapshot; other adapters can
opt in at their own verified identity boundary. Backlog and live replay use the
same persisted snapshot, without profile lookups or email-derived names.
Legacy, malformed, mismatched, or unverified metadata omits both additive
fields. Message text and assistant output cannot supply display attribution.

`GET /api/v2/agents/:id/live` is the ordered in-flight companion stream. It
replays server-accepted steering input while that input is pending and emits a
consumed or dismissed lifecycle update before removing the projection. These
events do not create another canonical user turn; clients reconcile them with
the durable user message by steering ID and visible input content.

An `assistant_text` event keeps `completionId`, `revision`, `text`, `isFinal`,
and `speechEligible` as the run-wide completion contract. Runtimes that also
send `presentationMode: "ordered_segments"` provide a `presentationSegment`
with an immutable `id` and `index`, its own cumulative `revision` and exact
Markdown `text`, `isFinal`, `startedAt`, and eventual `durableMessageIds`.
Clients should upsert visible prose by segment identity and use the parent
completion only for delivery and speech. A new segment begins after any visible
human input, tool activity, or runtime-status barrier, so later prose cannot be
patched backward across the intervening event. The projection never includes
thinking, tool arguments/results, or other hidden runtime payloads.
