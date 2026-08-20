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

Run `pnpm check:public-safety` before every commit. Commit messages must
describe code behavior only, never a live deployment or interaction.

## Local development workflow

- Use the repository-pinned PNPM version through Corepack. Run `pnpm install
  --frozen-lockfile`, `pnpm <script>`, and `pnpm exec <tool>` rather than
  creating independent npm dependency trees. Keep the PNPM store shared across
  local checkouts.
- Default to the canonical checkout on a clean `main`. Make small, executable,
  quickly verified changes there, then commit and push or open the required
  protected-branch review.
- Do not create a worktree merely for ordinary analysis, planning, testing, or
  a short refactor. Use one only when concurrent work or risky isolation truly
  requires it, record why, reuse the shared PNPM store, and remove the worktree
  and its dependencies as soon as the work is integrated or abandoned.
- Never leave a fan-out of stale worktrees or duplicate `node_modules`
  directories behind.

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

## Agent-authored message and loop-control contract

- Messages from another agent are first-class inbound collaboration when they
  arrive through an authorized channel or established direct conversation.
  Never discard, downgrade, or require an extra mention solely because the
  sender is a bot or agent.
- Do not add `sender_is_bot`, `isBot`, mention-only, cooldown, previous-speaker,
  or text-pattern guards as loop prevention. Those heuristics predictably drop
  handoffs, corrections, capabilities, and completion receipts while still not
  proving that a real loop exists.
- Loop control belongs at the agent decision boundary. The receiving agent must
  evaluate the message and call `yield_no_action` when it has nothing useful to
  add. A deliberate reply remains available when coordination is required.
- Transport safety should enforce authenticated self-echo rejection, durable
  provider-message deduplication, and channel/conversation authorization. Scope
  established direct conversations by durable conversation identity rather
  than by whether each later participant is human or automated.
- Tests for collaborative adapters must cover an unmentioned agent message in
  an established group DM, exact self-echo rejection, duplicate delivery, and
  rejection of an unestablished out-of-scope conversation.
- Collaboration/history tools must preserve complete provider-sized individual
  messages. Never silently clip a handoff and make the receiver infer the
  missing suffix. If an aggregate context budget is necessary, omit older whole
  messages with an explicit notice rather than truncating a shown message.

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
