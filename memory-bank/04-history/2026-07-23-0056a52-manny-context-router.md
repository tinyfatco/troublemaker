# Manny Deterministic Email Context Router

Date: 2026-07-23
Repository: `tinyfatco/troublemaker`
Runtime commit: `0056a52a8b23021fa83f6805abc1e63d93056ff7`

Commits:

- `bbe3827` — add the isolated context-routing host
- `766db0a` — keep email/project binding control-plane owned
- `ca786fb` — configure the rootless-container host gateway
- `34b5d19` — preserve the subject on native Gmail replies
- `0056a52` — fail closed when an attempted email reply is not delivered

Troublemaker now includes a standalone `hostd/` package that owns Manny's Gmail
polling and deterministic context resolution. It normalizes and HMAC-hashes the
exact sender identity, preserves immutable native Gmail thread bindings, selects
a project only when the control plane knows exactly one project for that
principal, and otherwise creates a private per-principal intake scope. Project
binding is not exposed as an agent tool. Ambiguous or missing project state
cannot cross-route a message.

Each resolved scope maps to a separate persistent workspace and rootless Podman
container. The child presents the same Manny identity while the host retains
Gmail credentials, routing metadata, and derived inbound/outbound capability
tokens. The host validates route ownership on outbound calls, deduplicates
delivery, replies through native Gmail threads with `gog`, and stops the child
after the turn. SQLite WAL stores routing metadata and ledgers, not plaintext
email addresses.

The Caveman multi-agent skill was pinned to upstream tag `v1.9.1`, commit
`0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0`, and mounted read-only into every
Manny child alongside TinyFat's standard skills. No remote installer or Gmail
credential is present inside the child runtime.

Verification completed locally:

- `npm test --prefix hostd`
- `npm run typecheck`
- `npm run build`
- `npm run test:email-host-managed`
- `npm run test:email-messages-only-boundary`
- `npm run test:email-webhook-auth`
- `npm run test:email-busy-steering`

Deployment and live QA:

- pushed branch `codex/troublemaker-hostd-20260723`
- deployed clean commit `0056a52` to `/opt/troublemaker` on the dedicated
  `manny-agent` VPS
- installed `troublemaker-hostd.service` as the unprivileged
  `troublemaker-hostd` user on loopback `127.0.0.1:3099`
- retained the existing `manny-agent.service` for Slack and rollback
- disabled the legacy `manny-inbox-poll.timer` to keep a single Gmail owner
- imported 22 legacy seen-message checkpoints without replay
- sent an ordinary, non-canary email from `alex@tinyfat.com` to
  `manny@tinyfat.com`
- observed deterministic routing into the private Alex intake context
- observed Manny load Caveman, call `send_message`, and deliver a native Gmail
  threaded reply with provider message ID `19f9084070890e29`
- observed the child exit successfully after delivery
- confirmed one principal, one context, zero pending events, two completed
  events, one completed outbox delivery, no running child container, and no
  host-router warnings
- Alex independently confirmed receipt of the reply

The first smoke turn exposed the Podman host-gateway and required-Gmail-subject
issues fixed by `ca786fb` and `34b5d19`. It did not deliver a reply. The
subsequent `0056a52` change makes this class of attempted-but-undelivered reply
fail closed so the host will not silently mark the inbound complete.

Known next-step gap: the email mesh is live, but the isolated child does not yet
have a scoped relay for delegating work to Batman, Batdog, Ghost, or Zip through
Slack. That relay should remain a host-owned capability rather than copying
workspace Slack credentials into child containers.
