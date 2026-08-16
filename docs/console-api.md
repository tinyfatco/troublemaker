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

The durable event stream remains the source of truth. Optimistic chat entries
are UI affordances, not persistent state.

`GET /api/v2/agents/:id/live` is the ordered in-flight companion stream. It
replays server-accepted steering input while that input is pending and emits a
consumed or dismissed lifecycle update before removing the projection. These
events do not create another canonical user turn; clients reconcile them with
the durable user message by steering ID and visible input content.
