# Claude Code CLI Backend

Troublemaker can use an existing Claude Code CLI login as a model backend. The
backend invokes `claude -p`, lets Claude Code own its native tool loop, and maps
Claude's `stream-json` response into Troublemaker's normal assistant stream.

Troublemaker does not implement Claude login. Install Claude Code and log in as
the same operating-system user that runs the Troublemaker service:

```bash
claude auth login
claude auth status
```

When `claude auth status` reports `loggedIn: true`, `/model` exposes exactly:

- `claude-cli/haiku`
- `claude-cli/sonnet`
- `claude-cli/opus`
- `claude-cli/fable`

Select one with `/model claude-cli/sonnet`, or set the resident service
environment:

```bash
MOM_MODEL_PROVIDER=claude-cli
MOM_MODEL_ID=sonnet
```

## Runtime Contract

Each turn runs Claude with `-p --output-format stream-json
--include-partial-messages --verbose --setting-sources user`. This deliberately
reuses the service user's Claude settings while excluding project and local
setting sources. Troublemaker appends its system prompt through a temporary
file, sends the turn over stdin, and passes the selected alias with `--model`.

Claude Code, not Pi, executes tools for these turns. Troublemaker remains
responsible for Slack ingress, unified awareness, final response delivery,
session reset, and stream presentation. Troublemaker-only tools such as
`send_message`, `list_channels`, and `self_configure` are not available inside
the Claude process. Because of that, `claude-cli` selections use ordinary
harness delivery even on platforms whose usual default is `messages-only`.
Adapter-level suppression for ambiguous ambient events is unchanged.

Fresh turns receive a UUID with `--session-id`. Successful sessions are stored
at `awareness/claude-cli-session.json` with mode `0600`; later turns use
`--resume`. `/clear` removes both Pi context and the Claude session binding. If
Claude's transcript disappeared, Troublemaker retries once with a new session
and a bounded textual reseed from its own context.

Claude owns native context compaction. Troublemaker disables Pi auto-compaction
for this backend and sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from the selected
model's context window.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `MOM_CLAUDE_CLI_PATH` | `claude` | Absolute CLI path for minimal systemd/launchd `PATH` values |
| `MOM_CLAUDE_CLI_PERMISSION_MODE` | unset | Explicit Claude permission mode, including `bypassPermissions` for an intentionally unrestricted host agent |
| `MOM_CLAUDE_CLI_TIMEOUT_MS` | `1800000` | Hard per-turn process timeout |
| `MOM_CLAUDE_CLI_IDLE_TIMEOUT_MS` | `300000` | Maximum time without stdout/stderr activity |
| `MOM_CLAUDE_CLI_AUTH_CACHE_MS` | `30000` | Cache duration for `claude auth status` model discovery |
| `MOM_CLAUDE_CLI_MAX_OUTPUT_CHARS` | `8388608` | JSONL output character limit |
| `MOM_CLAUDE_CLI_MAX_OUTPUT_LINES` | `20000` | JSONL output line limit |
| `MOM_CLAUDE_CLI_RESEED_CHARS` | `120000` | Maximum text retained when rebuilding a missing CLI session |

Troublemaker strips inherited Anthropic API keys, endpoint overrides, and
Claude OAuth token environment variables before launching the CLI. This keeps
the selected backend tied to the CLI profile the service user explicitly
logged into instead of silently switching to an API-key or third-party route.

`MOM_CLAUDE_CLI_PERMISSION_MODE=bypassPermissions` gives Claude Code the
service user's host permissions without interactive approval. Use it only on a
dedicated resident host with a deliberately scoped Unix user and credentials.

## Relationship To OpenClaw

This follows OpenClaw's Claude CLI backend shape: stdin prompts, `stream-json`,
partial messages, user setting sources, explicit model selection, durable
session IDs, resumed turns, bounded output, inherited auth override scrubbing,
and Claude-owned compaction. OpenClaw additionally maintains a live stdio
session and generates a per-run MCP bridge exposing its own tool catalog.
Troublemaker's first implementation intentionally omits that larger bridge;
Claude uses its native tools and Troublemaker delivers the returned response.
