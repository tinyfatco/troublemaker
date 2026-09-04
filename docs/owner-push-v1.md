# Portable owner push v1

`owner_push_v1` is one generic, server-owned notification capability for every
explicitly authorized agent relationship. Agent names are data; there are no
agent-specific routes, stores, payloads, providers, or model tools.

## Guarded availability

Agent status may advertise `capabilities.owner_push_v1: true` only when all of
the following are ready in the same guarded deployment:

1. `OwnerPushStore` on an owner-only local path.
2. `OwnerPushRuntime` with an exact current-context verifier.
3. `ConsoleAccessFacade` configured with that runtime.
4. A complete `AppleOwnerPushTransport` configuration.
5. An independent server-producer bearer configured on the facade.
6. The loopback Gateway constructed with `ownerPushAvailable: true` only after
   the facade and producer route are ready.

`createOwnerPushDeploymentFromEnvironment` returns the runtime and producer
credential as one handoff only when the APNs transport, protected store path,
context verifier, and producer credential are complete. Missing or partial
configuration fails closed. The standalone node entry point does not compose
the facade or producer and therefore always advertises the capability as false.
Missing context authority never falls back to an agent-global conversation.

## Server-owned APNs configuration

The guarded supervisor supplies:

- `TROUBLEMAKER_APNS_PRIVATE_KEY_FILE` — owner-only regular P-256 `.p8` key
- `TROUBLEMAKER_APNS_TEAM_ID`
- `TROUBLEMAKER_APNS_KEY_ID`
- `TROUBLEMAKER_APNS_TOPIC` — the signed app's exact bundle identifier
- `TROUBLEMAKER_OWNER_PUSH_PRODUCER_TOKEN` — independent 32-byte-or-longer
  authority used only by the authoritative server producer
- optional `TROUBLEMAKER_OWNER_PUSH_STORE_FILE` — absolute owner-only state path

These values never enter the client contract, APNs custom payload, awareness,
logs, diagnostics, model context, tools, or API responses. The transport uses
HTTP/2 token auth, `alert` push type, immediate priority, zero expiry, the app
topic, and the notification ID as `apns-collapse-id`.

## Authoritative completion and action producer

A separately authenticated server producer submits a strict content-free event:

- `POST /api/v2/owner-notification-events`
- `Authorization: Bearer <independent producer credential>`
- body: `{ "version": 1, "kind": "completion" | "action", "envelope": ... }`

The ordinary owner/device bearer is explicitly not producer authority. The
producer credential is consumed by the facade and never forwarded to the
Gateway, agent, model, adapter, or tool surface. The runtime re-verifies the
exact current context before admitting or dispatching the envelope.

An authoritative producer chooses one stable notification ID and event ID only
after the completion or action is committed. Exact retries preserve that body.
Changed-body reuse of a notification ID is rejected. Concurrent exact-ID calls
inside the one runtime coalesce onto one in-flight promise, so only one APNs
send can begin. Pending custody is persisted before transport; process restart
intentionally clears only the in-memory coalescer and retries the same pending
payload. An APNs-accepted destination is never resent.

## Registration and revocation

The owner bearer may call only the exact agent route:

- `POST /api/v2/agents/:id/owner-notification-devices`
- `DELETE /api/v2/agents/:id/owner-notification-devices/:installation_id`

Before registration, the facade re-resolves the upstream subject identity and
requires it and the payload route identity to match. The APNs token is retained
only in the owner-mode `0600` store. Responses and redacted snapshots omit it.
Registration is idempotent by installation, binding, route agent, and subject;
a token rotation updates that one identity. Revocation is route-and-subject
bound and survives restart.

## Read and opened reconciliation

After the iPhone durably records a read or opened transition, its exact-agent
owner bearer calls:

- `POST /api/v2/agents/:id/owner-notifications/:notification_id/acknowledgments`
- body: `{ "version": 1, "notification_id": ..., "installation_id": ...,
  "binding_id": ..., "state": "read" | "opened" }`

The facade re-resolves the subject, requires the path/body notification identity
to agree, and the store requires a currently registered installation matching
route, subject, and binding. Unknown, revoked, mismatched, malformed, ambiguous,
or `unread` acknowledgments fail closed. Replays are idempotent and state stays
monotonic `unread -> read -> opened` across restart. The client replays its
locally durable read/opened records after configuration, foreground transitions,
and successful registration so a prior transport failure can reconcile without
reopening or weakening the notification.

## Notification and context custody

The runtime proves that the registration relationship and current-context
verifier agree on route agent, subject agent, binding, relationship, context
kind, context ID, and optional anchor. The durable store then:

- admits a notification ID once;
- accepts exact same-ID replay;
- rejects same-ID route/body conflict;
- persists pending APNs custody before network activity;
- retries an interrupted dispatch after restart with the identical payload and
  collapse ID;
- does not resend an APNs-accepted destination;
- removes permanently invalid device tokens;
- keeps unread, read, and opened state monotonic across restart.

Contextual `events`/`live` query fields and `messages`/`messages/stop`
`ownerContext` bodies are verified by the facade. It injects a bounded internal
proof only after authorization. The Gateway and Web adapter require an exact
proof match before serving or executing contextual work.

The APNs custom data is exactly the synthetic fixture at
`test/fixtures/owner-push-notification-v1.json`. It contains opaque routing
identifiers only. Message text, task titles, relationship labels, tool data,
credentials, provider identity, and deployment topology are prohibited.
