# Claude Code CLI Inference Backend

Date: 2026-07-14
Commit: `f55f337` (`tinyfatco/troublemaker`)

Troublemaker now supports Claude Code's non-interactive `claude -p` mode as a
first-class inference backend. The implementation follows OpenClaw's backend
shape rather than Hermes Agent's Claude Code skill: OpenClaw uses the CLI as
the resident model process, while Hermes delegates selected coding tasks to a
separate terminal sub-agent.

Claude authentication remains entirely outside Troublemaker. The service user
must run `claude auth login`; when `claude auth status` reports `loggedIn:
true`, `/model` exposes `claude-cli/haiku`, `claude-cli/sonnet`,
`claude-cli/opus`, and `claude-cli/fable`. The backend is deliberately absent
from Troublemaker's `/login` OAuth registry.

Each turn invokes `claude -p` with streaming JSON, partial messages, the user
settings source, an appended Troublemaker system prompt, and either a fresh
session UUID or a persisted `--resume` ID. Claude Code owns its native tool
loop and context compaction. Troublemaker continues to own channel ingress,
unified awareness, session reset, streaming presentation, and final response
delivery. A missing Claude transcript triggers one bounded context reseed into
a fresh session.

The subprocess boundary strips inherited Anthropic API keys, endpoint
overrides, and OAuth-token environment variables so an explicitly selected
CLI backend cannot silently change billing or routing. It also enforces hard
and idle timeouts, bounded JSONL output, abort handling, atomic `0600` session
state, temporary `0600` image files, and an optional explicit Claude
permission mode for deliberately unrestricted resident hosts.

Verification:

- `npm run typecheck`
- `npm run build`
- `npm run test:claude-cli`
- `npm run test:system-prompt`
- `npm run test:channel-delivery-policy`
- `npm run test:model-config-list-models`
- `npm run test:model-config-current-selection`
- all post-validator UI/runtime tests except the unrelated failures below

`npm run validate:local` reaches the existing
`test:web-ui-voice-settings` failure because
`ui/src/components/VoiceSettingsMenu.tsx` is absent from both this branch and
`origin/main`. Running the later tests directly also reproduces the untouched
`test:web-ui-tool-expansion` auto-collapse timing assertion; the other later
tests pass.

The local Claude installation is version `2.1.208`. Its auth status currently
claims a logged-in Pro session, but a real print-mode smoke call returns HTTP
401 because the OAuth session is expired and cannot be refreshed. The
fake-CLI integration test covers the complete backend protocol; a new external
`claude auth login` is still required before live QA. This change was not
deployed to any resident agent.
