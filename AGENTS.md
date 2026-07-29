# Agent Guidelines for This Repository

## Public-repository safety

Treat every tracked file, commit message, issue, pull request, branch name, and
review comment as permanently public.

Never publish:

- Personal notes, session logs, work journals, memory banks, transcripts, or
  model reasoning from real interactions.
- Names, addresses, identifiers, messages, projects, or relationship details
  belonging to a real person, customer, prospect, employee, or deployed agent.
- Real deployment topology: hostnames, IP addresses, ports, tunnels, service
  names, server or droplet IDs, account or agent UUIDs, storage paths, ingress
  URLs, channel IDs, message IDs, allowlists, credential locations, or live
  configuration.
- Authentication material, signed URLs, invitation IDs, API responses,
  provider receipts, or realistic token-shaped strings.

Keep private operational records outside this repository. Directories such as
`memory-bank/`, `memory/`, `scratch/`, and runtime data directories must remain
untracked.

Tests and examples must use unmistakably synthetic fixtures:

- `example.com` email addresses and hostnames
- RFC 5737 documentation IP addresses
- `+1 555` phone numbers
- repeated or sequential fake UUIDs and platform IDs
- generic names such as Example Customer, Casey, or Operator

Run `npm run check:public-safety` before every commit. Commit messages must
describe code behavior only, never a live deployment or interaction.

## Client preview addresses

- Give each client preview a dedicated, descriptive business-specific
  `*.tinyfat.dev` hostname.
- Do not use short links, capability URLs, or provider-native deployment URLs
  as the client-facing handoff address.
- Internal staging URLs may support verification, but they are not a customer
  deliverable.

## Direct user-facing communication

- Communicate in plain language and name the actual state of the work.
- Do not expose internal phase codes, incident shorthand, routing identifiers,
  or implementation labels in user-facing messages.
- Say `local build`, `private review preview`, `customer preview`,
  `production`, `checking`, `working`, or `complete` when that is what you
  mean.

## Production-data operations

- Do not rediscover, copy, print, or commit live credentials during routine
  operations.
- When an owner-authorized production mutation must be performed by a
  designated infrastructure operator, hand off an exact idempotent operation
  and require a non-secret verification receipt.
- Keep real infrastructure names, credential locations, identifiers, and
  change receipts in approved private operations records, never in this public
  repository.

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
  voice-session TTS and the deliberate `speak` tool.

Commit messages count as public output: describe the behavior change, not the
live system where it was tested or deployed.
