# Platform Adapter Architecture

Mom's agent is platform-agnostic. It communicates through a `MomContext` interface that abstracts away all platform-specific behavior. Each platform (Slack, Telegram, etc.) implements a `PlatformAdapter` that translates between the platform's API and this context.

## Core Interfaces

### PlatformAdapter

The contract each platform implements. Handles connection lifecycle, message operations, metadata, and context creation.

```
PlatformAdapter
├── name, maxMessageLength, formatInstructions  — platform identity
├── start(), stop()                             — connection lifecycle
├── postMessage(), updateMessage(), deleteMessage(), postInThread()  — messaging
├── uploadFile()                                — file sharing
├── logToFile(), logBotResponse()               — persistence
├── getUser(), getChannel(), getAllUsers(), getAllChannels()  — metadata
├── createContext()                             — UX mapping (see below)
└── enqueueEvent()                             — scheduled event queue
```

### MomContext

What the agent talks through during a run. Created fresh per message by the adapter's `createContext()`. The agent calls these methods without knowing what platform it's on.

```
MomContext
├── message        — incoming message data (text, user, channel, attachments)
├── respond()      — append text to the main response
├── replaceMessage() — overwrite the main response entirely
├── respondInThread() — post detail (tool results, etc.) as supplementary
├── setTyping()    — show typing/thinking indicator
├── setWorking()   — show/hide working indicator (" ...")
├── uploadFile()   — attach a file to the conversation
└── deleteMessage() — delete the response for legacy quiet-event handling
```

### MomHandler

The handler that adapters call into when messages arrive. Implemented by `main.ts`.

```
MomHandler
├── isRunning(channelId)  — sync check if channel is busy
├── handleEvent(event)    — process a message (async)
├── handleSteer(event)    — soft-steer active work or queue a fresh turn without aborting
└── handleStop(channelId, adapter, event?) — abort current run and preserve response placement
```

### Inbound sender semantics

An authorized message does not become disposable because its sender is another
agent. Adapters must preserve sender metadata, reject exact self echoes and
duplicate provider deliveries, and enforce configured channel or conversation
scope. They must not use bot status or mention presence as a generic loop guard.
The agent evaluates each delivered turn and calls `yield_no_action` when no
response is useful.

### WorkspaceChannelTransport

Customer relationship workspaces use a narrower transport contract on top of
`PlatformAdapter`. It contains only the primitives a chat system must provide:
scoped post, edit, delete, thread reply, file upload, user/channel lookup, and
reply-target description.

`workspace-channel-context.ts` and `workspace-channel-runtime.ts` own the
product behavior shared by Mattermost and Rocket.Chat:

- strict messages-only output, with no harness-authored final prose;
- one edited, sanitized working-output message;
- thread replies, file handling, and best-effort cleanup;
- one serialized execution lane per relationship;
- replay suppression, slash commands, busy steering, and stop handling.

`test/workspace-channel-parity.test.ts` runs the same behavioral scenario over
fake Mattermost and Rocket.Chat transports and compares their operation logs.
A future workspace adapter, including Zulip, should be evaluated by adding its
transport to that same suite rather than copying an existing adapter.

## How It Fits Together

```
User message
    │
    ▼
PlatformAdapter (Slack/Rocket.Chat/Telegram/...)
    │  translates platform event → MomEvent
    │  calls handler.handleEvent()
    ▼
main.ts handler
    │  gets/creates channel state
    │  calls adapter.createContext() → MomContext
    │  calls runner.run(ctx)
    ▼
agent.ts (AgentRunner)
    │  builds system prompt with adapter.formatInstructions
    │  runs AgentSession
    │  on tool results: ctx.respondInThread(details)
    │  on final response: ctx.respond(text)
    ▼
MomContext callbacks
    │  adapter-specific implementation
    │  Slack: threads, mrkdwn, WebClient
    │  Telegram: replies, MarkdownV2, Bot API
    ▼
Platform API
```

## createContext() — The UX Layer

`createContext()` is where each adapter defines its user experience. The same agent event (`respondInThread` for tool details, `respond` for the final answer) can map to completely different platform behaviors:

**Slack adapter:**
- `respond()` → Edit a single accumulating message in the channel
- `respondInThread()` → Post as a thread reply (collapsible, detail-level)
- `setWorking()` → Append/remove " ..." suffix via message edit

**Telegram adapter:**
- `respond()` → Edit a single accumulating message via `editMessageText`
- `respondInThread()` → Reply to the main message (visible in chat, not collapsible)
- `setTyping()` → `sendChatAction("typing")`

This is the natural extension point for surfaces with genuinely different
interaction models. A Discord adapter might use embeds for tool details. A CLI
adapter might print to stderr. A web adapter might use a split pane. Customer
relationship workspaces should first implement `WorkspaceChannelTransport` so
their product semantics stay identical.

## Working-output routing

User-visible delivery and sanitized working progress are independent policies.
The source adapter always creates the canonical turn context, preserving its
message metadata, reply target, final/error delivery, and uploads. The host may
then decorate that context according to `settings.json` `workingOutput`:

- `follow` keeps the adapter's existing progress locus;
- `off` suppresses external working progress; and
- `fixed` routes safe tool labels from every turn to one configured Slack or
  Rocket.Chat or Mattermost channel/DM through the destination adapter.

A fixed destination uses a separate messages-only context. Ordinary assistant
text, raw tool arguments/results, stdout, reasoning, and harness finals never
move with the working stream. If the configured destination is unavailable,
progress fails closed instead of falling back to the source conversation.

This routing applies when a run is created, so a `self_configure` change takes
effect on the next turn and never relocates an in-flight working message.

## formatInstructions

Each adapter provides `formatInstructions` — a string injected into the agent's system prompt telling it how to format text for that platform:

- **Slack:** mrkdwn syntax (`*bold*`, `<url|text>`, no `**double asterisks**`)
- **Telegram:** MarkdownV2 syntax (`*bold*`, `[text](url)`, escape special chars)

The agent adapts its output formatting without any code changes.

## Adding a New Adapter

1. Create `adapters/<platform>.ts` implementing `PlatformAdapter`.
2. For a customer relationship workspace, implement
   `WorkspaceChannelTransport` and delegate context/runtime behavior to the
   shared workspace modules.
3. Implement only platform-specific event parsing, authentication, scope
   enforcement, and transport primitives.
4. Add the transport to `test/workspace-channel-parity.test.ts`.
5. Set `formatInstructions`, register the adapter in `main.ts`, and add its
   configuration.

That's it. The agent, handler, events system, session management, and tools all work unchanged.

## Adapter Modes

Each platform adapter supports multiple connection modes — one for always-on deployments (VPS, on-prem) and one for serverless (CF, Lambda):

### Slack

| Mode | CLI flag | Env vars | Connection |
|------|----------|----------|------------|
| **Socket Mode** (default) | `--adapter=slack` or `slack:socket` | `MOM_SLACK_APP_TOKEN` + `MOM_SLACK_BOT_TOKEN` | Outbound WebSocket. Always-on. |
| **Webhook (Events API)** | `--adapter=slack:webhook` | `MOM_SLACK_BOT_TOKEN` + `MOM_SLACK_SIGNING_SECRET` | HTTP server on `MOM_HTTP_PORT` (default 3000). Serverless-friendly. |

Socket Mode and HTTP Events API are **mutually exclusive per Slack app** — you must choose one in the Slack admin console.

### Mattermost

| Mode | CLI flag | Env vars | Connection |
|------|----------|----------|------------|
| **WebSocket + REST** | `--adapter=mattermost` or `mattermost:socket` | `MOM_MATTERMOST_URL` + `MOM_MATTERMOST_BOT_TOKEN` | Outbound WebSocket events with REST sends, threads, edits, deletes, and file uploads. Always-on. |

Mattermost channel/thread delivery uses explicit `mattermost:<channel_id>[:<root_post_id>]` targets. `MOM_MATTERMOST_ALLOWED_DM_USERS` optionally limits DM invocation to comma-separated user IDs or usernames. `MOM_MATTERMOST_ALLOWED_CHANNELS` limits all inbound posts, outbound posts, file operations, and thread reads to an explicit comma-separated channel-ID allowlist. `MOM_MATTERMOST_CHANNEL_MESSAGES_DIRECT=true` treats every non-self post in those channels as direct input, which is appropriate for a private Operator room.

Per-agent `settings.json` can route fixed `workingOutput` to a Mattermost
channel. `mattermost.mentionsOnlyChannelIds` is an attention policy, not an
access policy: ordinary posts in those rooms are logged but do not schedule
ambient evaluation, while explicit @mentions still wake the agent and
`read_thread` continues to use the live Mattermost API. Agents may update this
through `self_configure` setting `mattermost.channel_attention`.

### Rocket.Chat

| Mode | CLI flag | Env vars | Connection |
|------|----------|----------|------------|
| **Host-managed webhook** | `--adapter=rocket-chat:webhook` | `MOM_ROCKETCHAT_URL` + `MOM_ROCKETCHAT_BOT_TOKEN` + `MOM_ROCKETCHAT_INBOUND_TOKEN` + `MOM_ROCKETCHAT_ALLOWED_ROOMS` | Host pushes room events over loopback HTTP; a per-context capability proxies only allowed REST operations. |

Rocket.Chat is the operator projection for a TinyFat customer relationship, not
the canonical relationship store. Hostd owns the native credential, DDP
subscription, room/contact binding, awareness sequence, and durable outbound
idempotency. The runtime can read and append only inside its single allowed
private room. Explicit `rocket-chat:<room_id>[:<root_message_id>]` targets work
with `send_message` and `read_thread`. Posts, edits, deletes, thread reads and
replies, outbound uploads, and inbound attachment downloads are restricted to
the bound relationship room and message/file graph. Unscoped REST routes remain
intentionally unavailable.

### Telegram

| Mode | CLI flag | Env vars | Connection |
|------|----------|----------|------------|
| **Polling** (default) | `--adapter=telegram` | `MOM_TELEGRAM_BOT_TOKEN` | Outbound `getUpdates` polling. Always-on. |
| **Webhook** (planned) | `--adapter=telegram:webhook` | `MOM_TELEGRAM_BOT_TOKEN` + secret | HTTP server receives pushed updates. Serverless-friendly. |

### Discord

| Mode | CLI flag | Env vars | Connection |
|------|----------|----------|------------|
| **Gateway** | `--adapter=discord` or `discord:gateway` | `MOM_DISCORD_BOT_TOKEN` + `MOM_DISCORD_APPLICATION_ID` | Outbound API v10 WebSocket for DMs, mentions, replies, and opt-in ambient messages; REST for sends. |
| **Interactions webhook** | `--adapter=discord:webhook` | Bot token + application ID + `MOM_DISCORD_PUBLIC_KEY` | Signed inbound HTTP interactions; the compatible relay route remains available. |

The Gateway adapter discovers its endpoint through `/gateway/bot`, tracks
sequence and session state, resumes after recoverable disconnects, watches
heartbeat acknowledgements, and uses bounded jittered reconnects. It checks the
session-start budget and local five-second Identify window before identifying.
If Discord recommends multiple shards, configure one shard per process rather
than silently receiving partial guild coverage.

Ambient guild intake is off by default. Optional guild, guild-channel,
global-user, and DM-user allowlists are applied before metadata, activity
tracking, or workspace logging. The global-user list applies everywhere;
guild and channel lists apply only to guild messages, and the DM-user list
applies only to DMs. Applicable configured lists compose with logical AND, and
an explicitly empty list denies its scope. DM channel IDs are dynamic and never
need to appear in the guild-channel allowlist. See the README for environment
names and startup examples.

## File Structure

```
src/
├── adapters/
│   ├── types.ts          — PlatformAdapter, MomContext, MomEvent, MomHandler
│   ├── slack-base.ts     — SlackBase abstract class (shared WebClient, metadata, backfill, context, logging)
│   ├── slack-socket.ts   — SlackSocketAdapter (Socket Mode — outbound WebSocket)
│   ├── slack-webhook.ts       — SlackWebhookAdapter (HTTP Events API — inbound HTTP)
│   ├── mattermost-socket.ts   — MattermostSocketAdapter (outbound WebSocket + REST)
│   ├── rocket-chat-webhook.ts — Host-managed Rocket.Chat customer-room adapter
│   ├── discord-base.ts        — Shared Discord REST, boundaries, normalization, and context
│   ├── discord-gateway.ts     — DiscordGatewayAdapter (outbound API v10 Gateway)
│   ├── discord-webhook.ts     — DiscordWebhookAdapter (signed Interactions HTTP)
│   └── telegram.ts            — TelegramAdapter (polling + Bot API)
├── agent.ts              — AgentRunner, system prompt, tool handling
├── main.ts               — CLI, adapter factory, handler, channel state
├── events.ts             — Scheduled event watcher
├── context.ts            — Session sync, settings manager
├── store.ts              — Channel data persistence
├── sandbox.ts            — Docker/host execution
└── tools/                — Tool implementations (bash, read, write, edit, attach)
```
