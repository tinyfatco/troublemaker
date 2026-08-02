# Troublemaker Host

Troublemaker Host is a single-machine control plane for company inboxes,
customer collaboration channels, and isolated Troublemaker runtimes. It keeps
provider credentials outside agent containers, journals delivery in SQLite,
and binds native conversations to durable OCI contexts.

When `gmail` is configured, hostd uses `gog` for native Gmail reads, drafts,
and delivery. Normal mail remains in Gmail; no forwarding mailbox or
reconstructed email transport is involved. A phone-and-Zulip business may omit
`gmail` entirely; those runtimes receive no email adapter or Gmail tools.

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

## Scoped Pages-style site previews

When top-level `sites` is configured, a project may bind one exact TinyFat Site
to its verified principal/project scope. The runtime then receives one
`site_deploy` tool and a context capability that is valid only at Hostd. It does
not receive a Sites admin bearer, agent tools token, Cloudflare token, or the
Hostd signing key.

```json
{
  "sites": {
    "publishUrl": "https://publish.example.com",
    "previewApex": "business.example.com",
    "previewNamespace": "example-sites-preview",
    "productionNamespace": "example-sites-production",
    "capabilityPrivateKeyEnv": "SITES_CAPABILITY_PRIVATE_KEY",
    "capabilityKeyId": "hostd-example-1",
    "capabilityTtlSeconds": 60
  },
  "routing": {
    "knownPrincipals": [
      {
        "email": "customer@example.com",
        "projects": [
          {
            "slug": "website",
            "name": "Example website",
            "siteDeployment": {
              "grantId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "customerId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              "projectId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              "siteId": "11111111-1111-4111-8111-111111111111",
              "siteSlug": "example-business",
              "artifactKinds": ["static", "worker"],
              "allowedBranches": ["*"]
            }
          }
        ]
      }
    ]
  }
}
```

Hostd resolves the caller from its durable context, ignores caller-selected
site/customer identity, validates the exact Git branch and workspace-relative
artifact directory, rejects links and special files, enforces file and byte
limits, creates a deterministic archive, and signs a short-lived Ed25519
capability bound to immutable grant/customer/project/site IDs, branch slot,
host-derived source commit, preview environment/namespace/hostname, artifact
digest, actor reference, expiry, and idempotency key. Hostd requires the bound
workspace to be one clean, attached Git repository on the requested branch;
the runtime cannot supply the signed SHA. Sites Publish independently verifies
those claims against site custody and recomputes the artifact digest.

Preview hostnames follow the Cloudflare Pages shape:
`<branch-label>.<site-slug>.business.tinyfat.dev`. Lossy or long Git branch
names receive a deterministic SHA-256 suffix so two exact branches cannot
collapse into one hostname. The initial runtime tool is preview-only;
production promotion remains a separate control-plane action bound to an
accepted artifact.

## Commands

```bash
troublemaker-hostd serve --config /etc/troublemaker-hostd/config.json
troublemaker-hostd poll-once --config /etc/troublemaker-hostd/config.json
troublemaker-hostd provision-rocketchat --config /etc/troublemaker-hostd/config.json
troublemaker-hostd provision-mattermost --config /etc/troublemaker-hostd/config.json
troublemaker-hostd provision-zulip --config /etc/troublemaker-hostd/config.json
troublemaker-hostd import-legacy-checkpoint \
  --config /etc/troublemaker-hostd/config.json \
  --checkpoint /var/lib/legacy-inbox/checkpoint.json \
  --key-file /etc/legacy-inbox/state.key
troublemaker-hostd status --config /etc/troublemaker-hostd/config.json
```

`serve` binds its API to loopback by default. OCI ports must also be published
on loopback only. Do not expose the host API or child gateway ports publicly.

## Routing

Ordinary Gmail identity comes only from normalized `From`, `To`, and `Cc`
envelope headers. Hostd removes the configured inbox and every exact domain in
`gmail.internalDomains`, then requires exactly one external address. Zero or
multiple external candidates are durably quarantined and left unread before a
principal, route, context, or event can be created. Message bodies and quoted
text never supply routing identity.

An existing native thread binding only wins when that one external participant
is already explicit in the binding. An unexpected participant is quarantined
and left unread; it cannot inherit or rebind another principal's context. A new
external participant becomes a private principal. A new thread routes to that
principal's sole known project when there is exactly one, otherwise it routes
to the principal's private `intake` scope. Project membership is control-plane
configuration: runtimes cannot name, move, or merge their own scope. There is
no global customer context and no privileged master runtime.

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

## Direct SMS

An optional `phone` connector consumes signed provider webhooks through either
a dedicated loopback listener or an authenticated durable edge relay. In relay
mode, Hostd makes outbound pull requests; no Hostd listener is public. Relay
records are encrypted before edge storage, and Hostd independently rechecks
the original provider signature after decrypting them. Direct-listener mode
must publish only the webhook listener through a narrowly routed HTTPS reverse
tunnel. The Hostd API and child gateway ports remain loopback-only in both
modes.

The connector fails closed when its signature or relay secrets are absent,
filters to its one configured sender, and supports direct SMS text only. Group
markers, multiple recipients, media, MMS, and unknown event shapes are
quarantined before they can create a context.

A new direct correspondent receives a private `intake` principal and one
durable OCI context. Hostd stores the contact address encrypted and gives the
runtime only a redacted label plus an opaque `phone-…` target. The runtime
cannot see provider credentials, the business number, the contact number, or
recipient-selection fields.

Agent-authored replies use `send_message` against the opaque target. Hostd
rechecks context ownership and opt-out state, resolves the encrypted direct
recipient, pins the message body to an idempotency key, and calls the provider.
An ambiguous provider result is held for operator review instead of retried.
Harness errors, greetings, and status text are never sent to the phone thread;
all visible replies must come from an agent tool call.

The example Zulip configuration uses reserved `+1 555` fixtures. Keep real
numbers, API keys, webhook secrets, tunnel hostnames, and deployment receipts
in host configuration or a private operations repository.

Website forms and other server-owned relays still enter through the native
Gmail inbox. Configure a `gmail.contactRelays` entry with the relay sender,
shared HMAC secret environment variable, and control-plane-owned project. This
verified path remains separate from ordinary envelope candidate selection. A
verified relay may substitute its one exact signed `Reply-To` address as the
customer principal and may supply a display label. A matching relay sender with
missing, invalid, or mismatched signature headers is quarantined. The form
never calls the operator workspace directly.

Host-owned `gmail.alwaysTo` recipients are added to every scoped draft as
visible To participants, while `gmail.alwaysCc` recipients remain visible Cc
participants. Runtimes cannot add, remove, or replace either list. Hostd binds
both recipient sets before send and emits matching plain-text and minimal HTML
alternatives without imposing a fixed content width.

The customer email is the durable identity. On its first verified submission,
Hostd lazily creates a new principal/project context and a fresh private
operator channel. Later native threads and form submissions from the same
normalized email reuse that stored context and numeric channel binding.
Human-readable channel names are labels only and never authorize reuse.

Ingress only journals work; it never waits for an agent turn. The scheduler
leases up to `scheduler.maxConcurrent` contexts globally and one turn per
context, then relies on fenced runtime heartbeats and completion receipts.
Expired leases are recovered after a crash. Idle runtimes are stopped after
`scheduler.idleSeconds`, and the least-recently-active idle runtime is evicted
when a new context needs a full host's slot. Workspaces remain durable.

Build `hostd/Containerfile.runtime` from a verified checkout and set
`immutableImage: true`. In that mode the runtime uses code baked into the image
and does not mount the mutable host checkout. `runtimeVersion` forces existing
containers to be replaced on their next wake. Target `skills` accepts one path
or an ordered array of read-only skill roots.

Set `hostGateway` to the address containers use for the host loopback proxy.
Docker commonly provides `host.containers.internal`; rootless Podman with
slirp4netns commonly uses `10.0.2.2`.

Hostd supports native `docker` and Podman-style engine commands. Docker
launches use its host-gateway mapping and remove only the deterministic stopped
context container before recreation. Podman launchers retain `--replace`,
`keep-id`, and rootless slirp host-loopback flags.

## Rocket.Chat relationship work and Omnichannel conversations

When `rocketChat` is configured, hostd deterministically maps every durable
customer context to a native Omnichannel Contact, one private internal
relationship room, and one visible Operator bot identity. Each Gmail or Sendly
provider thread maps separately to a native Omnichannel conversation. The
Contact aggregates linked identities and conversation history; conversation
status, assignment, queues, monitoring, and analytics remain native Rocket.Chat
operations. The encrypted TinyFat awareness stream remains the durable
cross-conversation relationship record.

The immutable relationship-room slug is opaque; the provider-normalized
customer email is used only in the Contact and human-facing room metadata. The
room stores its Omnichannel Contact ID alongside the TinyFat customer channel
ID. Configured operator usernames are added through Rocket.Chat's native
private group membership. No Rocket.Chat credential enters a customer runtime.

Provider ingress uses the authenticated
`tinyfat/omnichannel/conversation` Business OS endpoint. Stock Rocket.Chat's
generic Livechat room-creation route is intentionally unsupported because it
erases the provider source to `api`. The TinyFat endpoint delegates contact,
visitor, routing, room, and agent handling to Community Omnichannel while
preserving `email` or `sms`. Hostd supplies `verified: true` only after its
identity layer has authenticated and journaled the exact endpoint.

Keep both native admin credential components in the host environment with
`rocketChat.adminUserIdEnv` and `rocketChat.adminTokenEnv`. A literal
`adminUserId` remains accepted for backward-compatible non-secret
configuration.

Every routed Gmail inbound and every successful agent-authored Gmail delivery
is atomically paired with a per-customer awareness sequence. A host-owned
projector posts each event into the room with its stable event ID, customer
channel ID, sequence, source, actor, visibility, direction, and delivery status
in TinyFat message custom fields. Replays are idempotent. Rocket.Chat is the
operational projection; the ordered awareness relationship remains the durable
TinyFat contract.

Hostd also owns one outbound Rocket.Chat DDP connection. It subscribes to the
operator account's private-room messages, discards system events and TinyFat
projections, and journals each real human message into the bound customer
context before waking that runtime. The runtime receives the message through
`POST /rocketchat/inbound`; it never receives the native Rocket.Chat credential.

The `rocket-chat:webhook` runtime adapter can read the current relationship
thread and explicitly post, edit, delete, reply in-thread, or upload through a
context-capability-scoped host proxy. Every operation is restricted to the
bound relationship room and visible Operator credentials; arbitrary Rocket.Chat
API routes and access to another customer's room fail closed.

Inbound operator attachments use the same boundary. The runtime receives only a
host-proxy URL naming the bound room message and file. Hostd revalidates that
the message belongs to the relationship and that the file is actually attached
to that message before downloading it with the Operator's host-owned credential.

Mattermost and Rocket.Chat share one workspace-neutral customer collaboration
protocol for messages-only output policy, edited working output, threads,
inbound and outbound files, cleanup, replay protection, steering, stop
handling, and per-channel serialization. Zulip implements the same protocol
without threads for channels configured with `empty_topic_only`. Their adapter
classes provide transport primitives and event parsing rather than separate
product behavior.

Only one operator workspace may be active in a hostd configuration. Existing
Mattermost support remains available as a migration path.

## Topic-free Zulip customer channels

When `zulip` is configured, Hostd maps each durable customer context to one
private channel named from the verified external identity, for example
`customer · Casey`. Hostd enforces Zulip's `empty_topic_only` policy so the
channel is one sequential relationship feed rather than a set of
transport-shaped topics.

The host owns three classes of Zulip identity: an administrator for
provisioning and event intake, Operator for agent-authored work, and `TINYFAT`
for inbound/outbound email ledger projection. Configured members and observers
are subscribed to every customer channel; observer messages are ignored by the
Operator ingress loop.

Customer runtimes receive only per-context capability tokens. Hostd constrains
reads, messages, edits, deletes, typing, and uploads to the bound numeric
channel, and native Zulip API keys never enter the runtime. Successful
`send_message` calls close the current working-output segment; later tool work
opens a new segment beneath the sent message so the feed remains chronological.

Each binding stores an `ambient` or `mentions-only` attention mode. Ambient is
the default; mentions-only keeps the channel readable and writable while
suppressing ordinary human posts from waking the Operator.

The standalone resident bridge can use a broader first-class mode. With no
static stream allowlist, it follows the bot's current Zulip subscriptions,
accepts newly subscribed channels without a restart, preserves normal topics,
and delivers individual or group direct messages. Optional stream allowlists
and direct-message conversation establishment retain fail-closed deployments.
An allowed principal must establish a direct conversation first; after that,
messages from every participant in that durable conversation, including another
agent, are delivered without requiring a mention. Sender bot status remains
context, not an ingress veto. The runtime evaluates the turn and uses
`yield_no_action` when no reply is useful. Native API keys and the full user
directory remain bridge-only; the resident receives scoped capabilities,
subscribed-channel metadata, message participants, and sender bot status.

## Legacy private Mattermost rooms

When `mattermost` is configured, the host deterministically provisions one
private Mattermost channel and one Operator bot account per context. The
human-visible channel name is the verified sender's exact email address. An
opaque internal Mattermost slug remains the immutable routing key because
Mattermost machine names cannot contain email punctuation. The provisioning
admin remains a human member, and the host adds that Operator plus the
configured observer. One host-owned WebSocket receives room events even while
the private Operator is asleep. Each real bot token stays in a host-only `0600`
credential file. Containers receive a context capability and use a
channel-scoped host proxy for Mattermost REST operations, so the real token
never enters the runtime.

Hostd also provisions one host-owned `TINYFAT` bot as the room's email ledger.
Every routed Gmail inbound is atomically paired with a durable notification,
and TINYFAT posts a new top-level room message with the sender, recipient,
project scope, context hash, subject, and email body. Every successful
`gmail_send` is atomically paired with a separate top-level TINYFAT message
containing the outbound sender, recipient, subject, and exact verified draft
body. Notification delivery is retried and idempotent. The host gateway
classifies TINYFAT posts as control-plane output, so they never become a
duplicate Operator inbound turn. Its token stays in the same host-only credential
directory.

On first initialization, hostd fixes the private Operator's sanitized working
output to that room. The setting remains agent-configurable afterward. An
observer can independently mark the room `mentions-only`, which suppresses ambient
evaluation while preserving explicit @mentions and live `read_thread` access.

The host URL may be a loopback tunnel. `runtimeUrl` remains accepted for
backward-compatible provisioning configuration but host-managed runtimes use
the hostd proxy. `provision-mattermost` reconciles rooms for existing contexts;
new contexts are provisioned lazily on their first wake.

## Operations

`GET /v1/status` reports queue depth, active leases, available slots, dead and
quarantined events, and context lifecycle state. `POST /v1/drain` stops new
leases while allowing active turns to finish; `POST /v1/resume` resumes the
scheduler. Both mutation routes require the configured operator token.

For rootless Podman under a system service, enable lingering for the hostd user
and point `XDG_RUNTIME_DIR` plus `DBUS_SESSION_BUS_ADDRESS` at that user's real
systemd session. Configure the target's `engine` as
`hostd/bin/podman-user-session` so each Podman command is launched by the
persistent user manager. A process started directly in the hostd system unit
cannot move its child into the user's cgroup tree, even when the user bus is
reachable. The wrapper deliberately uses `KillMode=process`; otherwise systemd
tears down Podman's rootless network helper when the detached CLI exits.

If the unit uses `ProtectHome=yes`, bind the exact runtime directory back into
the unit. Preserve any Podman runroot managed by the hostd unit with
`RuntimeDirectoryPreserve=yes` so restarting hostd does not remove state needed
by still-resident runtimes. Without the user session, Podman falls back to
`cgroupfs` and may record `--memory` without placing the container in a
distinct cgroup. Verify a live runtime's `/proc/<pid>/cgroup` and `memory.max`;
do not infer enforcement from `podman inspect` alone.

See `config.example.json` for Rocket.Chat and
`config.zulip.example.json` for the topic-free Zulip shape.
