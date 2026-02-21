# Troublemaker

An AI agent runtime with multi-platform adapters. Connects to Slack, Telegram, and Email — runs tools, manages files, and maintains persistent memory across sessions.

> **Don't want to self-host?** [tinyfat.com](https://tinyfat.com) runs it for you.

Built on [mom](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://mariozechner.at/). Troublemaker extracts mom's agent core into a standalone runtime with multi-platform adapters. Mom does the thinking — troublemaker gets it to more places.

## How It Works

When a message arrives from any platform, troublemaker hands it to the mom agent. Mom is **self-managing**: she installs her own tools, writes [CLI tools ("skills")](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/), configures credentials, and maintains her workspace autonomously.

**For each conversation** (Slack channel, Telegram chat, email thread), the agent maintains:
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
Telegram webhook ─► │  POST /telegram/webhook  │
Email webhook ────► │  POST /email/inbound     │
Health check ─────► │  GET  /health            │
                    └─────────────────────────┘
```

All adapters share one HTTP server with path-based routing. The gateway starts first, then adapters initialize independently — if one adapter fails to start, the others keep working.

For always-on deployments (VPS, Docker), Slack Socket Mode and Telegram polling adapters are also available — no inbound HTTP required.

## Quick Start

```bash
# Clone and build
git clone https://github.com/tinyfatco/troublemaker.git
cd troublemaker
npm install
npm run build
npm link

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
| `telegram` / `telegram:polling` | Outbound polling | `MOM_TELEGRAM_BOT_TOKEN` | Always-on |
| `telegram:webhook` | Inbound HTTP | `MOM_TELEGRAM_BOT_TOKEN`, `MOM_TELEGRAM_WEBHOOK_SECRET` | Webhook-based |
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

## Environment Variables

| Variable | Required For | Description |
|----------|-------------|-------------|
| `ANTHROPIC_API_KEY` | All | Anthropic API key |
| `MOM_SLACK_APP_TOKEN` | slack:socket | Slack app-level token (xapp-...) |
| `MOM_SLACK_BOT_TOKEN` | slack:* | Slack bot token (xoxb-...) |
| `MOM_SLACK_SIGNING_SECRET` | slack:webhook | HMAC signing secret for webhook verification |
| `MOM_TELEGRAM_BOT_TOKEN` | telegram:* | Telegram bot token from @BotFather |
| `MOM_TELEGRAM_WEBHOOK_URL` | telegram:webhook | Public URL for webhook registration |
| `MOM_TELEGRAM_WEBHOOK_SECRET` | telegram:webhook | Secret token for request verification |
| `MOM_SKIP_WEBHOOK_REGISTRATION` | telegram:webhook | Skip Telegram webhook registration (for external management) |
| `MOM_EMAIL_TOOLS_TOKEN` | email:webhook | Token for email send API |
| `MOM_EMAIL_SEND_URL` | email:webhook | Email send endpoint (default: `https://tinyfat.com/api/email/send`) |
| `MOM_HTTP_PORT` | — | Gateway port override (same as `--port`) |

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
npm install
npm run dev        # Watch mode
npm run build      # Production build
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
