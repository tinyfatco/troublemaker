# Claude CLI Runtime Auth Preflight

Date: 2026-07-14
Commit: `4e1cde2` (`tinyfatco/troublemaker`)

The first live Batman turn after enabling `claude-cli` failed before the custom
stream function ran with `No API key found for claude-cli`. Claude Code itself
was installed, authenticated, and healthy. The rejection came from Pi
`AgentSession.prompt()`, which requires `ModelRegistry.hasConfiguredAuth()` to
pass before handing control to any custom stream backend.

Troublemaker now registers a fixed, non-secret, runtime-only auth marker for
the synthetic `claude-cli` provider. The same marker satisfies the low-level
Agent request-auth callback. It is never persisted into `auth.json`, exposed
through `/login`, placed in Claude arguments or stdin, or inherited by the
Claude subprocess. Real authentication remains exclusively owned by the
service user's existing `claude auth login` profile.

Regression coverage creates a fresh in-memory `AuthStorage` and
`ModelRegistry`, proves Pi recognizes `claude-cli/sonnet` as configured, proves
no credential was persisted, and proves the marker never reaches the fake
Claude process. Existing subprocess, model-discovery, prompt, and delivery
tests remain green.

Verification:

- `npm run typecheck`
- `npm run build`
- `npm run test:claude-cli`
- `npm run test:model-config-list-models`
- `npm run test:model-config-current-selection`
- `npm run test:system-prompt`
- `npm run test:channel-delivery-policy`

Batman was validated on `tiny-bat` from the clean pushed commit `4e1cde2`.
The service retained its existing Slack identity, workspace, host sandbox, and
loopback port `3019`, while its model configuration became
`claude-cli/sonnet` with Claude's `bypassPermissions` mode. A loopback operator
turn logged `Model: claude-cli/sonnet`, streamed a normal response, and
completed without the API-key failure. The persisted assistant record reports
provider `claude-cli`, requested model `sonnet`, resolved response model
`claude-sonnet-5`, and stop reason `stop`.

The deployment restart also cleared abandoned Wrangler descendants from
Batman's systemd cgroup, reducing its idle footprint from roughly 4.1 GB and
135 tasks to roughly 180 MB and 11 tasks. Slack Socket Mode and
`http://127.0.0.1:3019/health` were healthy after restart.
