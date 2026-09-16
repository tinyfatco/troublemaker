# Native Codex image generation

Local Troublemaker agents expose `imagegen` alongside their standard tools,
including through the host-tool bridge. It works independently of the chat
model and computer backend. The host needs a current Codex CLI with native
image generation and an active `codex login` session. No OpenAI API key is used.

Call with `prompt` and, optionally, up to five `referenced_image_paths` inside
the agent workspace. Inspect references before editing. The result contains
unique PNG paths under `outputs/imagegen` and inline images up to 5 MiB each.
Use `attach` to deliver the selected image through the conversation's channel.
Larger images remain available as files.

Each request starts a dedicated ephemeral Codex app-server session. It does not
resume or read other agent sessions. The integration disables inherited MCP
servers, app/computer/browser/shell tools, hooks, and project instructions.
Codex owns authentication and generation; there is no alternate-provider fallback.
Codex may retain native generated-image artifacts under its own image directory;
Troublemaker copies only image bytes returned by the current request's protocol.

`CODEX_IMAGEGEN_COMMAND` overrides the executable, followed by
`CODEX_CLI_COMMAND`, then `codex` on PATH. Requests time out after ten minutes,
support cancellation, and report missing images, account limits, malformed
responses, and failed turns as errors. No automatic retry creates duplicate jobs.
A runtime restart is required to load a tool update.

Verify with `pnpm exec tsx test/imagegen.test.ts` and `pnpm typecheck`.
The integration uses Codex's experimental app-server protocol; rerun a real
synthetic generation and edit after a CLI upgrade.
