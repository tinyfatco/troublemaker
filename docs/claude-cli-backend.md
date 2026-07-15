# Claude Code CLI Backend

Troublemaker can use an existing Claude Code CLI login as a model backend. The
backend invokes `claude -p`, lets Claude Code own the inference/tool loop, and
maps Claude's `stream-json` response into Troublemaker's normal assistant
stream. Tool execution still belongs to Troublemaker through a local MCP
bridge.

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

For the duration of the turn, Troublemaker starts an authenticated MCP server
on a random `127.0.0.1` port and unguessable path. Claude spawns a short-lived
stdio MCP proxy that connects to this loopback server with credentials stored
only in a temporary mode-`0600` MCP config. The proxy only relays MCP tool-list
and tool-call requests; the live tools and their credentials remain inside
Troublemaker. This stdio hop lets Claude initialize the tool server eagerly
while retaining the authenticated per-turn boundary around the runtime.

`--strict-mcp-config` excludes every other configured MCP server. Claude's
built-in action catalog is replaced with `ToolSearch`, the non-acting discovery
tool required by Claude to resolve deferred MCP tools, and slash-command skills
are disabled. Only `ToolSearch` and `mcp__troublemaker__*` are pre-approved.
Native `SendMessage` is also explicitly denied because it is a Claude
team-agent tool, not Troublemaker's channel delivery tool.

The MCP server exposes the same live `AgentTool` instances used by Pi,
including `bash`, `read`, `write`, `edit`, `send_message`, `list_channels`,
`read_thread`, `self_configure`, and `yield_no_action`. Calls are surfaced
through Troublemaker's existing tool-event pipeline, so Slack tool-label
selection, send ordering, output snapshots, and logging remain consistent.
`yield_no_action` sets the same silent-completion state as a Pi-native call.

Troublemaker remains responsible for ingress, unified awareness, and channel
delivery. `messages-only` retains its normal meaning for Claude: ordinary model
text is recorded but not posted, and the model must use `send_message` for
visible communication. Thinking deltas are not mapped into the assistant
stream, and text belonging to nested Claude tool/subagent events is ignored.

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
session. Troublemaker uses a short-lived stdio proxy in front of an authenticated
loopback MCP server per `claude -p` turn, which preserves Troublemaker's
existing live tools and channel event pipeline without exposing a durable local
tool endpoint.
