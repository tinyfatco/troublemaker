# Troublemaker Host

Troublemaker Host is a single-machine control plane for company inboxes and
singular Troublemaker runtimes. It keeps provider credentials outside agent
containers, journals delivery in SQLite, and binds native conversations to
durable isolated OCI contexts.

The initial connector uses `gog` for native Gmail reads, drafts, and delivery.
Normal mail remains in Gmail; no forwarding mailbox or reconstructed email
transport is involved.

## Scoped Gmail tools

A target with `gmailToolsOnly: true` exposes four short runtime tools:

- `gmail_search` searches threads available to the current context.
- `gmail_read` returns one sanitized thread after the same context check.
- `gmail_draft` creates a reply or new-message draft, or updates only the body
  of a previously returned draft.
- `gmail_send` sends only a previously returned draft.

The host keeps OAuth outside the runtime. New messages accept one exact verified
contact and do not expose CC or BCC. Reply subjects come from the provider
thread. Draft recipient and thread bindings cannot be changed after creation,
and delivery rechecks recipient, subject, thread, body digest, and attachment
absence before sending. Provider message and thread IDs are stored with an
idempotent receipt. Ambiguous delivery outcomes stop for operator review rather
than retrying automatically.

When this setting is enabled, generic email adapter delivery fails closed; the
runtime must save a draft and may then send that exact draft autonomously within
the verified context.

## Commands

```bash
troublemaker-hostd serve --config /etc/troublemaker-hostd/config.json
troublemaker-hostd poll-once --config /etc/troublemaker-hostd/config.json
troublemaker-hostd provision-mattermost --config /etc/troublemaker-hostd/config.json
troublemaker-hostd import-legacy-checkpoint \
  --config /etc/troublemaker-hostd/config.json \
  --checkpoint /var/lib/legacy-inbox/checkpoint.json \
  --key-file /etc/legacy-inbox/state.key
troublemaker-hostd status --config /etc/troublemaker-hostd/config.json
```

`serve` binds its API to loopback by default. OCI ports must also be published
on loopback only. Do not expose the host API or child gateway ports publicly.

## Routing

Existing native thread bindings always win. A new sender becomes a private
principal. A new thread routes to that principal's sole known project when
there is exactly one, otherwise it routes to the principal's private `intake`
scope. Project membership is control-plane configuration: runtimes cannot name,
move, or merge their own scope. There is no global customer context and no
privileged master runtime.

```json
{
  "routing": {
    "actorTarget": "front-desk",
    "knownPrincipals": [
      {
        "email": "customer@example.com",
        "projects": [{ "slug": "website", "name": "Company website" }]
      }
    ]
  }
}
```

The actor target uses the `oci` driver. One runtime is lazily created per
principal/project scope, while all runtimes share the same actor template and
external mailbox identity.

On small hosts, `stopAfterTurn` can stop the process after a completed turn
while retaining its private workspace for the next wake. This preserves
context isolation without keeping every customer runtime resident in memory.
Target `skills` accepts one path or an ordered array of read-only skill roots;
the host mounts each root into every context without copying it into customer
workspaces.

Set `hostGateway` to the address containers use for the host loopback proxy.
Docker commonly provides `host.containers.internal`; rootless Podman with
slirp4netns commonly uses `10.0.2.2`.

## Private Mattermost rooms

When `mattermost` is configured, the host deterministically provisions one
private Mattermost channel and one Manny bot account per context. The
provisioning admin remains a human member, and the host adds that Manny plus the
configured Batman user. Each bot token is stored in a host-only `0600`
credential file and passed only to its owning container. The runtime also
receives `MOM_MATTERMOST_ALLOWED_CHANNELS` for the single channel, so inbound
events and outbound operations fail closed outside the context even if server
membership is accidentally broadened.

On first initialization, hostd fixes the private Manny's sanitized working
output to that room. The setting remains agent-configurable afterward. Batman
can independently mark the room `mentions-only`, which suppresses ambient
evaluation while preserving explicit @mentions and live `read_thread` access.

The host URL may be a loopback tunnel, while `runtimeUrl` is the corresponding
address visible from the rootless container network. Keep `stopAfterTurn`
disabled while a direct Mattermost WebSocket adapter is expected to receive
Batman replies. `provision-mattermost` eagerly provisions rooms for existing
contexts; new contexts are provisioned lazily on their first wake.

See `config.example.json` for the complete shape.
