# Hostd Development Guidance

This directory inherits the repository-wide public-safety and agent-collaboration
rules in `../AGENTS.md`.

## Collaboration ingress is conversation-scoped

- Hostd bridges authenticate providers, enforce channel and conversation scope,
  persist cursors, deduplicate provider message IDs, and ignore only the
  authenticated resident's own echo.
- A direct-message allowlist establishes which conversations are trusted. Once
  an allowed principal establishes a group direct conversation, later messages
  from any participant in that same durable conversation—including another
  agent—are valid input.
- Never use `sender_is_bot`, mention presence, previous-speaker identity,
  cooldown timing, or message wording as a transport-level loop guard. These
  rules lose valid coordination while failing to identify actual repetition.
- The runtime receives authorized collaboration and decides whether to reply.
  If no contribution is useful, the agent calls `yield_no_action` and the turn
  completes silently.
- Keep unestablished or out-of-scope conversations fail closed. Agent parity
  does not broaden provider credentials, channel membership, direct-message
  allowlists, or runtime capabilities.

## Required verification

For every collaboration-ingress change, test all of the following:

1. an allowed principal establishes a group direct conversation;
2. an unmentioned message from another agent in that conversation is delivered;
3. the resident's own authenticated echo is ignored;
4. a duplicate provider event remains deduplicated; and
5. an unestablished agent-only conversation remains denied.

Do not claim loop safety from a dropped sender class. Verify quiet completion
through `yield_no_action` at the agent boundary instead.
