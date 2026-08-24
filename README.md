# Troublemaker

An AI agent runtime with multi-platform adapters. Connects to Microsoft Teams, Slack, Zulip, Rocket.Chat, Mattermost, Telegram, and Email — runs tools, manages files, and maintains persistent memory across sessions.

Built on [mom](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://mariozechner.at/). Troublemaker extracts mom's agent core into a standalone runtime with multi-platform adapters. Mom does the thinking — troublemaker gets it to more places.

## Don't want to self-host?

[tinyfat.com](https://tinyfat.com) runs troublemaker for you — managed agents with sandboxed containers, multi-channel delivery, and scheduled events. No servers, no Docker, no ops.

## How It Works

When a message arrives from any platform, troublemaker hands it to the mom agent. Mom is **self-managing**: she installs her own tools, writes [CLI tools ("skills")](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/), configures credentials, and maintains her workspace autonomously.

**For each conversation** (Microsoft Teams, Slack, Zulip, Rocket.Chat, or Mattermost channel, Telegram chat, email thread), the agent maintains:
- **Persistent memory** — `MEMORY.md` files (global + per-channel) loaded into every prompt
- **Full history** — `log.jsonl` with searchable message archive, `context.jsonl` for the LLM window
- **Custom tools** — Skills the agent writes and reuses across sessions
- **Scheduled events** — Cron jobs, reminders, and webhook triggers via event files

The agent has full bash access (in a Docker sandbox or on host), reads/writes files, and creates whatever tools it needs. You provide a working directory — the agent does the rest.

## Architecture

```
                    ┌─────────────────────────┐
                    │    Unified Gateway       │
                    │    (single HTTP server)  │
                    │    port 3002             │
                    ├─────────────────────────┤
Slack webhook ────► │  POST /slack/events      │
Teams webhook ────► │  POST /teams/messages    │
Rocket.Chat host ─► │  POST /rocketchat/inbound│
Zulip host ───────► │  POST /zulip/inbound     │
Telegram webhook ─► │  POST /telegram/webhook  │
Email webhook ────► │  POST /email/inbound     │
Health check ─────► │  GET  /health            │
                    └─────────────────────────┘
```

All adapters share one HTTP server with path-based routing. The gateway starts first, then adapters initialize independently — if one adapter fails to start, the others keep working.

For always-on deployments (VPS, Docker), Slack Socket Mode, Mattermost WebSocket, and Telegram polling adapters are also available — no inbound HTTP required.

## Quick Start

```bash
# Clone and build
git clone https://github.com/tinyfatco/troublemaker.git
cd troublemaker
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm link --global

# Set platform tokens
export ANTHROPIC_API_KEY=sk-ant-...
export MOM_SLACK_APP_TOKEN=xapp-...    # Socket Mode
export MOM_SLACK_BOT_TOKEN=xoxb-...

# Run (auto-detects adapters from env vars)
troublemaker ./data

# Or specify adapters explicitly
troublemaker --adapter=slack:webhook,telegram:webhook --port=3002 ./data
```

## Adapters

| Adapter | Mode | Env Vars Required | Use Case |
|---------|------|-------------------|----------|
| `slack` / `slack:socket` | Outbound WebSocket | `MOM_SLACK_APP_TOKEN`, `MOM_SLACK_BOT_TOKEN` | Always-on (VPS, Docker) |
| `slack:webhook` | Inbound HTTP | `MOM_SLACK_BOT_TOKEN`, `MOM_SLACK_SIGNING_SECRET` | Webhook-based |
| `teams:webhook` | Authenticated Bot Connector HTTP | `MOM_TEAMS_CLIENT_ID`, client secret or managed identity | Personal/group chats, channels, threads, ambient RSC messages, reactions, personal files, and inline images |
| `mattermost` / `mattermost:socket` | Outbound WebSocket + REST | `MOM_MATTERMOST_URL`, `MOM_MATTERMOST_BOT_TOKEN` | Self-hosted or managed Mattermost |
| `rocket-chat:webhook` | Host-managed HTTP + scoped REST proxy | `MOM_ROCKETCHAT_URL`, `MOM_ROCKETCHAT_BOT_TOKEN`, `MOM_ROCKETCHAT_INBOUND_TOKEN`, `MOM_ROCKETCHAT_ALLOWED_ROOMS` | TinyFat customer relationship rooms |
| `zulip:webhook` | Host-managed HTTP + scoped REST proxy | `MOM_ZULIP_URL`, `MOM_ZULIP_BOT_TOKEN`, `MOM_ZULIP_INBOUND_TOKEN` | Subscribed channels, topics, ambient messages, and direct messages |
| `telegram` / `telegram:polling` | Outbound polling | `MOM_TELEGRAM_BOT_TOKEN` | Always-on |
| `telegram:webhook` | Inbound HTTP | `MOM_TELEGRAM_BOT_TOKEN`, `MOM_TELEGRAM_WEBHOOK_SECRET` | Webhook-based |
| `discord` / `discord:gateway` | Outbound Gateway WebSocket + REST | `MOM_DISCORD_BOT_TOKEN`, `MOM_DISCORD_APPLICATION_ID` | Always-on; no public ingress or relay |
| `discord:webhook` | Signed inbound Interactions HTTP | Discord bot token, application ID, and public key | Slash commands and compatible relay deployments |
| `email:webhook` | Inbound HTTP | `MOM_EMAIL_TOOLS_TOKEN` | Webhook-based |

**Auto-detection:** If no `--adapter` flag is given, troublemaker detects which adapters to start based on which env vars are set. Multiple adapters can run simultaneously.

## CLI

```
troublemaker [options] <working-directory>

Options:
  --sandbox=host              Run tools on host (default)
  --sandbox=docker:<name>     Run tools in Docker container (recommended)
  --adapter=<name>[,<name>]   Platform adapters (default: auto-detect)
  --port=<number>             Gateway HTTP port (default: 3000)

  --download <channel-id>     Download Slack channel history and exit
```

### Terminal UI

The optional terminal UI connects to an already-running Troublemaker gateway, so the resident agent remains the sole owner of its context, tools, and active run. Install a short command for each agent, then invoke the agent by name:

```bash
troublemaker-tui install demo-agent \
  --url http://127.0.0.1:3002 \
  --name "Demo Agent"

demo-agent
```

The installer creates a profile in `~/.config/troublemaker/tui.json` and a command symlink in `~/.local/bin`. Keep the gateway loopback-only (or reach it through a local tunnel), and ensure `~/.local/bin` is on your `PATH`. The UI uses Pi's terminal styling, labels messages by source, follows the resident's live awareness stream, shows only agent-supplied tool labels, and supports `/help`, `/reload`, `/status`, `/clear`, `/stop`, and `/quit`. Input remains available during active turns so follow-ups can soft-steer the same terminal run, and automatic context compaction is labeled explicitly instead of appearing as continued thinking.

Busy DMs and explicit @mentions use the same non-interrupting contract across
adapters: the message soft-steers an accepting model at its next safe boundary,
or queues as a fresh canonical turn. Ordinary user input never aborts an active
tool or run; `stop` remains the explicit cancellation control.

## Environment Variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API models | Anthropic API key; not used by the Claude CLI backend |
| `MOM_CLAUDE_CLI_PATH` | claude-cli models | Claude executable path (default: `claude`) |
| `MOM_CLAUDE_CLI_PERMISSION_MODE` | claude-cli host tools | Optional explicit Claude permission mode |
| `MOM_SLACK_APP_TOKEN` | slack:socket | Slack app-level token (xapp-...) |
| `MOM_SLACK_BOT_TOKEN` | slack:* | Slack bot token (xoxb-...) |
| `MOM_SLACK_SIGNING_SECRET` | slack:webhook | HMAC signing secret for webhook verification |
| `MOM_SLACK_INBOUND_TOKEN` | slack:webhook | Scoped bearer capability when a trusted host proxy verifies Slack instead |
| `MOM_TEAMS_CLIENT_ID` | teams:webhook | Microsoft Entra application and bot ID |
| `MOM_TEAMS_CLIENT_SECRET` | teams:webhook | Bot client credential; omit when using managed identity |
| `MOM_TEAMS_MANAGED_IDENTITY_CLIENT_ID` | teams:webhook | Managed identity client ID, or `system` |
| `MOM_TEAMS_TENANT_ID` | teams:webhook | Single tenant used for Bot Connector authentication |
| `MOM_TEAMS_CLOUD` | teams:webhook | Optional `Public`, `USGov`, `USGovDoD`, or `China` cloud |
| `MOM_TEAMS_SERVICE_URL` | teams:webhook | Optional Bot Connector service URL override |
| `MOM_TEAMS_ALLOWED_TENANTS` | teams:webhook | Optional comma-separated tenant allowlist |
| `MOM_TEAMS_ALLOWED_TEAMS` | teams:webhook | Optional comma-separated team allowlist |
| `MOM_TEAMS_ALLOWED_CONVERSATIONS` | teams:webhook | Optional comma-separated durable conversation allowlist |
| `MOM_TEAMS_ALLOWED_DM_USERS` | teams:webhook | Optional comma-separated durable Teams or Entra user IDs allowed in personal/group chats |
| `MOM_TEAMS_CHANNEL_MESSAGES_DIRECT` | teams:webhook | When `true`, every allowed channel post directly wakes the agent; otherwise unmentioned traffic is ambient |
| `MOM_MATTERMOST_URL` | mattermost:* | Mattermost base URL, for example `https://mattermost.example.com` |
| `MOM_MATTERMOST_BOT_TOKEN` | mattermost:* | Mattermost bot personal access token |
| `MOM_MATTERMOST_ALLOWED_DM_USERS` | mattermost:* | Optional comma-separated user IDs or usernames allowed to invoke the agent by DM |
| `MOM_MATTERMOST_ALLOWED_CHANNELS` | mattermost:* | Optional comma-separated channel IDs; inbound, outbound, files, and thread reads fail closed outside them |
| `MOM_MATTERMOST_CHANNEL_MESSAGES_DIRECT` | mattermost:* | When `true`, every non-self post in an allowed channel directly wakes the agent |
| `MOM_ROCKETCHAT_URL` | rocket-chat:webhook | Host-owned, context-scoped Rocket.Chat REST proxy URL |
| `MOM_ROCKETCHAT_BOT_TOKEN` | rocket-chat:webhook | Per-context host capability, never the native Rocket.Chat token |
| `MOM_ROCKETCHAT_INBOUND_TOKEN` | rocket-chat:webhook | Per-context bearer token for host-delivered room events |
| `MOM_ROCKETCHAT_ALLOWED_ROOMS` | rocket-chat:webhook | Required comma-separated room allowlist; all reads and writes fail closed outside it |
| `MOM_ROCKETCHAT_AGENT_NAME` | rocket-chat:webhook | Human-facing agent name used in the local transcript |
| `MOM_ZULIP_URL` | zulip:webhook | Host-owned, context-scoped Zulip REST proxy URL |
| `MOM_ZULIP_BOT_TOKEN` | zulip:webhook | Per-context host capability, never the native Zulip API key |
| `MOM_ZULIP_INBOUND_TOKEN` | zulip:webhook | Per-context bearer token for host-delivered channel and direct-message events |
| `MOM_ZULIP_ALLOWED_CHANNELS` | zulip:webhook | Optional numeric stream allowlist; when omitted, the adapter follows the bot's live subscriptions |
| `MOM_ZULIP_ALLOWED_DM_USERS` | zulip:webhook | Optional comma-separated Zulip user IDs allowed to invoke the agent by direct message |
| `MOM_ZULIP_CHANNEL_MESSAGES_DIRECT` | zulip:webhook | When `true`, every non-self channel message directly wakes the agent; otherwise unmentioned traffic is ambient |
| `MOM_ZULIP_AGENT_NAME` | zulip:webhook | Human-facing agent name used in the local transcript |
| `MOM_TELEGRAM_BOT_TOKEN` | telegram:* | Telegram bot token from @BotFather |
| `MOM_TELEGRAM_WEBHOOK_URL` | telegram:webhook | Public URL for webhook registration |
| `MOM_TELEGRAM_WEBHOOK_SECRET` | telegram:webhook | Secret token for request verification |
| `MOM_TELEGRAM_INBOUND_TOKEN` | telegram:webhook | Scoped bearer capability when a trusted host proxy verifies Telegram instead |
| `MOM_SKIP_WEBHOOK_REGISTRATION` | telegram:webhook | Skip Telegram webhook registration (for external management) |
| `MOM_DISCORD_BOT_TOKEN` | discord:* | Discord bot token; never put it in source or logs |
| `MOM_DISCORD_APPLICATION_ID` | discord:* | Discord application snowflake |
| `MOM_DISCORD_PUBLIC_KEY` | discord:webhook | Ed25519 public key for signed Interactions |
| `MOM_DISCORD_INBOUND_TOKEN` | discord:webhook relay | Scoped bearer capability for `/discord/messages`; relay ingress is disabled when omitted |
| `MOM_DISCORD_GATEWAY` | auto-detection | Set to `true` to explicitly auto-select `discord:gateway` |
| `MOM_DISCORD_GATEWAY_INTENTS` | discord:gateway | Optional decimal intent bitfield (default `37377`) |
| `MOM_DISCORD_GATEWAY_AMBIENT_MESSAGES` | discord:gateway | Set to `true` to observe non-mention guild messages (default `false`) |
| `MOM_DISCORD_GATEWAY_SHARD_ID` | discord:gateway | Optional zero-based shard handled by this process; set with shard count |
| `MOM_DISCORD_GATEWAY_SHARD_COUNT` | discord:gateway | Optional total shard count; set with shard ID |
| `MOM_DISCORD_ALLOWED_GUILDS` | discord:* | Optional comma-separated guild snowflakes |
| `MOM_DISCORD_ALLOWED_CHANNELS` | discord:* | Optional comma-separated guild-channel snowflakes; not applied to DMs |
| `MOM_DISCORD_ALLOWED_USERS` | discord:* | Optional comma-separated user snowflakes for all inbound messages |
| `MOM_DISCORD_ALLOWED_DM_USERS` | discord:* | Optional comma-separated user snowflakes for DMs |
| `MOM_EMAIL_TOOLS_TOKEN` | email:webhook | Token for email send API |
| `MOM_EMAIL_SEND_URL` | email:webhook | Email send endpoint (default: `https://tinyfat.com/api/email/send`) |
| `MOM_EMAIL_INBOUND_TOKEN` | email:webhook | Required scoped bearer capability for inbound email delivery (minimum 32 bytes) |
| `MOM_PHONE_INBOUND_TOKEN` | phone:webhook | Required scoped bearer capability for inbound phone delivery (minimum 32 bytes) |
| `MOM_FORM_INBOUND_TOKEN` | form:webhook | Required scoped bearer capability for inbound form delivery (minimum 32 bytes) |
| `MOM_OPERATOR_INBOUND_TOKEN` | operator routes | Enables `/operator/*` with a scoped bearer capability (minimum 32 bytes); routes are disabled when omitted |
| `MOM_HTTP_PORT` | — | Gateway port override (same as `--port`) |

### Discord Gateway

Gateway mode receives DMs, bot mentions, and replies to known bot messages over
an outbound Discord API v10 WebSocket. Ordinary guild messages are discarded
unless ambient intake is explicitly enabled. Enable the **Message Content**
privileged intent for the Discord application, then run:

```bash
export MOM_DISCORD_BOT_TOKEN='<bot-token>'
export MOM_DISCORD_APPLICATION_ID='<application-snowflake>'
troublemaker --adapter=discord ./data
```

Allowlist variables are scope-aware and conjunctive within their scope.
`MOM_DISCORD_ALLOWED_USERS` applies to every inbound message; guild and channel
lists apply only to guild messages, while `MOM_DISCORD_ALLOWED_DM_USERS` applies
only to DMs. Every applicable list that is set must match. An unset list adds no
restriction, while a set-but-empty list denies that scope; for example,
`MOM_DISCORD_ALLOWED_DM_USERS=''` denies all DMs before metadata, activity
tracking, or workspace logging. A DM never needs its dynamic channel ID in
`MOM_DISCORD_ALLOWED_CHANNELS`.

Gateway mode is never selected from credentials alone. Use the explicit CLI
mode above, or set `MOM_DISCORD_GATEWAY=true` for environment auto-detection.
When a public key is present and Gateway opt-in is absent, existing signed
`discord:webhook` auto-detection is preserved. Large bots run one configured
shard per process with both `MOM_DISCORD_GATEWAY_SHARD_ID` and
`MOM_DISCORD_GATEWAY_SHARD_COUNT`.

### Claude Code CLI Models

An existing Claude Code login can provide subscription-backed inference through
`claude -p`. Troublemaker never performs this login itself. After the resident
service user runs `claude auth login`, `/model` exposes
`claude-cli/{haiku,sonnet,opus,fable}` and honors that user's Claude JSON
settings. See [docs/claude-cli-backend.md](docs/claude-cli-backend.md) for the
session, permission, delivery, and security contract.

## Data Directory

Each platform channel gets its own subdirectory:

```
./data/
├── MEMORY.md              # Global memory (all conversations)
├── settings.json          # Settings (compaction, retry, etc.)
├── events/                # Scheduled events (cron, one-shot, immediate)
├── skills/                # Global CLI tools the agent creates
├── C123ABC/               # Slack channel
│   ├── MEMORY.md          # Channel-specific memory
│   ├── log.jsonl          # Full message history
│   ├── context.jsonl      # LLM context window
│   └── skills/            # Channel-specific tools
└── tg-456789/             # Telegram chat
    └── ...
```

## Memory

The agent uses `MEMORY.md` files to persist context across sessions:

- **Global memory** (`data/MEMORY.md`) — Shared across all channels. Project context, preferences, conventions.
- **Channel memory** (`data/<channel>/MEMORY.md`) — Per-conversation context, decisions, ongoing work.

These are loaded into the system prompt on every message. The agent updates them autonomously as it learns, or you can edit them directly.

## Skills

The agent can write custom CLI tools (skills) for your specific workflows. Each skill has a `SKILL.md` with frontmatter describing its name and purpose, plus any scripts or programs needed.

Skills live in `data/skills/` (global) or `data/<channel>/skills/` (channel-specific). The agent sees all available skills in its prompt and reads the full `SKILL.md` when it decides to use one.

See [pi-skills](https://github.com/badlogic/pi-skills) for example skills.

## Events

The agent can schedule events that wake it up:

| Type | Trigger | Use Case |
|------|---------|----------|
| **Immediate** | On file creation | Webhooks, external signals |
| **One-shot** | At a specific time, once | Reminders, scheduled tasks |
| **Periodic** | Cron schedule | Daily summaries, inbox checks |

Event files go in `data/events/`. External systems can also write events here to trigger the agent without going through a platform.

## Natural follow-ups

Follow-up mode lets the harness wake the agent at successive idle checkpoints after a completed, directly addressed human turn. Each wake runs through a non-direct headless adapter, re-reads the conversation, and asks the agent to send at most one concise follow-up with `send_message`, or stay quiet with `yield_no_action`. Ordinary assistant text and working output are discarded. A newer human message immediately invalidates the older sequence.

Follow-ups are opt-in for every workspace, including newly seeded ones. The `default` preset enables checkpoints at 1, 3, 5, and 10 minutes and can be selected directly in `settings.json`:

```json
{
  "followUps": "default"
}
```

Custom checkpoints use whole minutes:

```json
{
  "followUps": {
    "enabled": true,
    "preset": "custom",
    "intervalsMinutes": [2, 6, 10]
  }
}
```

The agent can make the same durable changes with `self_configure` settings `follow_ups`, `follow_ups.enabled`, `follow_ups.preset`, and `follow_ups.intervals_minutes`. Setting `follow_ups.cancel` to `true` cancels current sequences without disabling the configured preset. `/status` reports pending sequences, scheduled and claimed wake counts, and the next wake time. Pending wake files and generation claims survive restart; overdue unclaimed wakes are rearmed after downtime of any length, while stale, claimed, and duplicate generations fail closed.

## Security

The agent has full bash access in its execution environment. Use Docker sandbox mode to isolate it.

**Docker mode** (recommended): Commands run inside an isolated container. Only the mounted data directory is accessible from your host.

**Host mode**: Commands run directly on your machine with your user permissions. Only use in disposable environments.

The agent can be susceptible to prompt injection — treat it like a junior developer with terminal access. Use dedicated bot accounts with minimal permissions, scope credentials tightly, and never provide production secrets.

## Deployment

### Docker (recommended)

```bash
docker run -d --name sandbox -v $(pwd)/data:/workspace alpine:latest tail -f /dev/null

troublemaker --sandbox=docker:sandbox ./data
```

### VPS / Bare Metal

```bash
troublemaker --sandbox=host ./data
```

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev        # Watch mode
pnpm build      # Production build
```

### Code Structure

- `src/main.ts` — Entry point, CLI args, adapter creation, gateway startup
- `src/gateway.ts` — Unified HTTP server with path-based routing
- `src/agent.ts` — Agent runner, tool execution, session management
- `src/adapters/` — Platform adapters (Slack, Telegram, Email)
  - `types.ts` — PlatformAdapter interface
  - `slack-socket.ts` / `slack-webhook.ts` — Slack adapters
  - `telegram-polling.ts` / `telegram-webhook.ts` — Telegram adapters
  - `email-webhook.ts` — Email adapter
- `src/context.ts` — Session manager, log-to-context sync
- `src/store.ts` — Channel data persistence
- `src/sandbox.ts` — Docker/host sandbox execution
- `src/tools/` — Tool implementations (bash, read, write, edit, attach)
- `src/events.ts` — Scheduled events watcher

## Acknowledgments

Troublemaker is built on [mom](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://mariozechner.at/). The agent core — tool execution, context management, memory, skills, compaction — is mom's work. Troublemaker adds multi-platform adapters and a unified gateway.

## License

MIT
