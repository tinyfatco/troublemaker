# Ghost Duplicate Model Provider Routing

Date: 2026-07-19
Commit: `ffbdbfcdbf3a035053cee100e76556dd295102f2`
Repository: `tinyfatco/troublemaker`

Ghost was asked in Slack to use `gpt-5.6-sol` at `xhigh`. The model ID existed
under both `azure-openai-responses` and `openai-codex`, and the bare-ID lookup
returned the first exact registry match. Registry order placed the unauthenticated
Azure entry first, so `self_configure` persisted
`azure-openai-responses/gpt-5.6-sol`. Runtime auth resolution then silently fell
back to the configured Fireworks default, GLM 5.2.

The resolver now applies the same stable provider preference used by the model
picker when multiple providers expose an identical model ID. Subscription-backed
`openai-codex` ranks ahead of Fireworks, Claude CLI, Anthropic, direct OpenAI,
and unranked providers such as Azure. A regression fixture presents Azure first
and verifies that bare `gpt-5.6-sol` still resolves to `openai-codex`; explicit
provider/model queries remain unchanged.

Ghost's isolated workspace settings were corrected to:

- Provider: `openai-codex`
- Model: `gpt-5.6-sol`
- Thinking level: `xhigh`

The active Fireworks-backed turn was terminated during the LaunchAgent restart
after it compacted a 381k-token context. Completed usage records attributable to
the misconfigured window totaled `$15.3117` across seven billed fallback runs;
one run accounted for `$13.9788`. The interrupted final turn did not emit a
completed usage record, so provider-side billing may include additional partial
usage not represented by that log total.

Verification completed:

- `npm run test:model-config-list-models`
- `npm run test:self-configure` (97 passed)
- `npm run test:fireworks-model-resolution`
- `npm run typecheck`
- `npm run build`
- commit pushed to `origin/main`
- Ghost LaunchAgent restarted from the pushed checkout
- health returned `ok` from `http://127.0.0.1:3018/health`
- gateway listened only on `127.0.0.1:3018`
- live operator state reported `openai-codex/gpt-5.6-sol` and `xhigh`
- compiled bare-ID and current-model resolution both returned authenticated
  `openai-codex/gpt-5.6-sol`

No synthetic Slack turn was sent for post-restart QA. The next organic turn is
the remaining end-to-end confirmation that no auth warning or Fireworks fallback
appears. The pre-existing untracked `draft-comparison/` website artifact was
left untouched and was not included in the code commit.
