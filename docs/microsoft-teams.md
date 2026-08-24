# Microsoft Teams

Troublemaker's `teams:webhook` adapter is a first-class collaboration surface:
personal chats, group chats, channel posts, channel threads, unmentioned ambient
messages, agent-to-agent handoffs, edits, deletes, typing, reactions, files,
history discovery, follow-ups, working output, allowlists, durable delivery
deduplication, and busy-run steering all use the same runtime contracts as
Slack.

The adapter uses the current Microsoft Teams TypeScript SDK and leaves Bot
Connector JWT validation enabled. The public messaging endpoint is:

```text
https://bot.example.com/teams/messages
```

The gateway can remain behind a reverse proxy; only that route needs public
HTTPS ingress. Do not expose the gateway's other routes unless they have their
own documented authentication boundary.

`GET /health` reports process liveness only. `GET /readiness/teams` is the
Teams canary check and returns `503` until the current process has accepted an
authenticated inbound activity and then completed an outbound send to that
same conversation. Keep both diagnostic routes private.

## Register and install the app

1. Register a single-tenant Microsoft Entra application and retain its
   application (client) ID and tenant ID. Create a client secret or configure a
   managed identity for the runtime.
2. Create the bot registration with the same application ID. Set its messaging
   endpoint to the public `/teams/messages` URL.
3. Copy `examples/microsoft-teams/manifest.json`, replace the synthetic app ID,
   URLs, domain, and icons, then package `manifest.json`, `color.png`, and
   `outline.png` at the root of the compressed archive.
4. Upload the package in the Teams Developer Portal or admin center and install
   it in each personal chat, group chat, team, or channel where the agent should
   participate.
5. Approve the manifest's resource-specific consent permissions. They let the
   installed app receive unmentioned messages only in the team or chat where it
   is installed; they do not grant tenant-wide message access.

`ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` are required for Slack-
equivalent ambient and agent-to-agent behavior. Removing either permission
reduces ingress to the messages Teams delivers without that RSC grant. See
Microsoft's [all channel and chat messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-for-bots-and-agents)
and [file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)
documentation.

## Configure Troublemaker

```dotenv
MOM_TEAMS_CLIENT_ID=00000000-0000-0000-0000-000000000003
MOM_TEAMS_CLIENT_SECRET=...
MOM_TEAMS_TENANT_ID=00000000-0000-0000-0000-000000000001
MOM_TEAMS_ALLOWED_TENANTS=00000000-0000-0000-0000-000000000001
MOM_TEAMS_ALLOWED_TEAMS=00000000-0000-0000-0000-000000000002
MOM_TEAMS_CHANNEL_MESSAGES_DIRECT=false
```

With these variables present, adapter auto-detection starts `teams:webhook`.
It can also be selected explicitly:

```bash
troublemaker --adapter=teams:webhook --port=3000 ./data
```

Production deployments should set at least a tenant allowlist. Conversation,
team, and direct-message allowlists are optional additional boundaries. When an
allowlist variable is present but empty, it denies every member of that scope.
Direct-message allowlists accept durable Teams or Entra IDs only; display names
and usernames are not authorization identities. Missing or malformed Teams
configuration disables only this adapter so other configured adapters remain
available.

| Variable | Purpose |
|----------|---------|
| `MOM_TEAMS_CLIENT_ID` | Entra application and bot ID |
| `MOM_TEAMS_CLIENT_SECRET` | Bot credential; omit when using managed identity |
| `MOM_TEAMS_MANAGED_IDENTITY_CLIENT_ID` | Managed identity client ID, or `system` |
| `MOM_TEAMS_TENANT_ID` | Single tenant used for bot authentication |
| `MOM_TEAMS_CLOUD` | Optional `Public`, `USGov`, `USGovDoD`, or `China` cloud |
| `MOM_TEAMS_SERVICE_URL` | Optional Bot Connector service URL override |
| `MOM_TEAMS_ALLOWED_TENANTS` | Optional comma-separated tenant IDs |
| `MOM_TEAMS_ALLOWED_TEAMS` | Optional comma-separated team IDs |
| `MOM_TEAMS_ALLOWED_CONVERSATIONS` | Optional comma-separated durable conversation IDs |
| `MOM_TEAMS_ALLOWED_DM_USERS` | Optional comma-separated Teams or Entra object IDs allowed in personal/group chats |
| `MOM_TEAMS_CHANNEL_MESSAGES_DIRECT` | Treat every allowed channel post as a direct turn instead of ambient traffic |

Conversation references and pending file-consent records are stored as
owner-only runtime state in the agent workspace. Provider credentials are never
written there. Every operation rechecks the authenticated tenant, team when
applicable, conversation, and direct-message user boundary. Cached conversation
identity expires after seven days and must be refreshed by a new authenticated
activity before listing, history, file, or outbound operations resume.

## Delivery behavior

- Personal and group chats are established direct conversations. Messages from
  other authenticated agents are accepted even when they do not mention this
  agent. Only an exact self echo is rejected.
- Personal and group-chat history uses the durable conversation as its root;
  individual messages do not appear as separate thread targets.
- A channel mention wakes the agent. An unmentioned channel message is logged
  and enters ambient evaluation unless that conversation is configured as
  `mentions-only`.
- Replies default to the originating channel thread. Set
  `teams.response_placement` to `channel` to use top-level messages instead.
- Teams targets are URL-encoded to keep opaque conversation IDs unambiguous:
  `teams:<encoded-conversation-id>` or
  `teams:<encoded-conversation-id>:<encoded-message-id>`.
- Personal-chat files use Teams' native consent and file-info cards. Channel and
  group-chat messages can carry inline images up to 4 MiB. Other shared files
  must be sent as a SharePoint or OneDrive link: Microsoft requires a delegated
  Graph OAuth file flow outside the Bot Connector API for those scopes, so the
  adapter fails clearly instead of pretending an unsupported upload succeeded.

The runtime remembers the service URL on each authenticated inbound activity
and uses it for later proactive sends. This is important for regional and
sovereign deployments and survives a process restart.
