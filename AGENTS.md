# Agent Guidelines for This Repo

## This is a PUBLIC repository

Anything committed here is visible to the entire internet, immediately and
permanently (forks and caches survive history rewrites).

**Never commit:**

- Personal-notes-style documentation: session logs, work journals,
  memory-bank content, "what I did today" writeups.
- Operational details of real deployments: hostnames, IP addresses
  (public or private), ports, tunnel targets, droplet/server IDs,
  agent UUIDs, bucket paths, ingress URLs, email addresses, or
  allowlist/auth behavior of live systems.
- Anything describing a specific person, customer, or real agent
  relationship.

The `memory-bank/` directory is gitignored and local-only. Keep it that way.
Session notes and deployment records belong in the private fat-platform
memory bank (`~/code/tinyfatco/fat-platform/memory-bank/` on tiny-bat),
not here.

**Tests and examples** must use fake fixtures: documentation IPs
(`203.0.113.x`, `198.51.100.x`), `example.com` addresses, `555` phone
numbers, and made-up UUIDs — never real infrastructure values.

## Voice-control contract

- Derive the initial `hey <agent name>` wake phrase from the workspace
  `IDENTITY.md` `Name:` field; do not hardcode deployed identities. Before a
  session is awake, ambient speech must not become an agent turn.
- A committed voice utterance immediately interrupts assistant audio, but never
  aborts an active canonical run or tool. Queue voice follow-ups FIFO as fresh
  turns and drain them only at safe completion boundaries.
- Keep stop and pending-input controls immediate. Busy non-voice messages
  soft-steer the active model at its next safe boundary, or queue as a fresh
  turn when steering is temporarily unavailable; they never abort active work.
- Ordinary final responses are never spoken automatically. Preserve explicit
  voice-session TTS and the deliberate `speak` tool, but do not add automatic
  SAG or an equivalent final-response speech mode.

Commit messages count too: describe the change, not the live system it was
deployed to.
