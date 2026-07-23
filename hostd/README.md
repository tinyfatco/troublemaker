# Troublemaker Host

Troublemaker Host is a single-machine control plane for company inboxes and
singular Troublemaker runtimes. It keeps provider credentials outside agent
containers, journals delivery in SQLite, and binds native conversations to
durable isolated OCI contexts.

The initial connector uses `gog` for native Gmail reads and replies. Normal
mail remains in Gmail; no forwarding mailbox or reconstructed email transport
is involved.

## Commands

```bash
troublemaker-hostd serve --config /etc/troublemaker-hostd/config.json
troublemaker-hostd poll-once --config /etc/troublemaker-hostd/config.json
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

See `config.example.json` for the complete shape.
