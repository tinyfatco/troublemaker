# Codex CLI voice backend

Select `/model codex-cli/default` to run the installed Codex harness behind
Troublemaker's voice and chat surfaces. An explicit Codex model also works:
`/model codex-cli/<model-id>`. The default uses the CLI's built-in model default,
not the model in the user's config file.

Install Codex CLI and run `codex login` as the user running Troublemaker.
`codex login status` must succeed. No API key is copied into Troublemaker.
The integration was verified with Codex CLI 0.154.0.

For a service, set `MOM_MODEL_PROVIDER=codex-cli` and `MOM_MODEL_ID=default`.
Use the standard prompt profile (unset `TROUBLEMAKER_PROMPT_PROFILE=compact`).
Set `MOM_CODEX_CLI_PATH` if `codex` is not on the service's PATH, and `CODEX_HOME`
when the CLI profile lives outside the runtime's home directory.

In Computer, select **Settings → Agent Model → Codex CLI**, leave the model
blank for the default, and choose **Apply Model**. This requires a Computer
build containing the updated embedded Troublemaker runtime. An external
Troublemaker service can instead be selected through the existing external
agent setting. Computer still sends committed thoughts through `/api/v2` and
uses its established speech and tool presentation.

Codex owns the inference loop, transcript, and native compaction. Troublemaker
supplies its live tools through the same authenticated per-turn MCP bridge as
the Claude CLI backend. Each exposed tool is configured for automatic MCP
execution; authorization and tool implementation remain in Troublemaker.
Codex runs noninteractively with its native shell disabled, a read-only native
sandbox, and no inherited user configuration or apps. The service user's
existing CLI authentication remains available. Inherited OpenAI key and endpoint
overrides are removed. The MCP credentials are passed through subprocess
environment variables, not command arguments.

Completed assistant-message items become visible text; reasoning and raw MCP
payloads never become speech. This `codex exec --json` adapter delivers text at
message-item boundaries, rather than token-by-token. Tool events come directly
from the live bridge, preserving the existing event ordering and UI. Voice
follow-ups remain queued; explicit stop cancels the process. Ordinary channel
finals retain Troublemaker's existing delivery policy.

Successful thread IDs are stored privately in `awareness/codex-cli-session.json`.
Later turns resume that thread; `/clear` drops the binding. A missing thread is
retried once with a bounded conversation reseed. Errors and incomplete process
output are reported as failed turns instead of successful empty replies.

Timeout and output limits are configurable with `MOM_CODEX_CLI_TIMEOUT_MS`,
`MOM_CODEX_CLI_IDLE_TIMEOUT_MS`, `MOM_CODEX_CLI_MAX_OUTPUT_CHARS`,
`MOM_CODEX_CLI_MAX_OUTPUT_LINES`, `MOM_CODEX_CLI_RESEED_CHARS`, and
`MOM_CODEX_CLI_AUTH_CACHE_MS`. Defaults match the Claude CLI backend.

Protocol reference: [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode).
