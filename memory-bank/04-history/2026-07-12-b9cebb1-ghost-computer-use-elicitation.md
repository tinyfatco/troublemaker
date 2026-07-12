# Ghost Computer Use App Approval

Date: 2026-07-12
Commit: `b9cebb1` (`tinyfatco/troublemaker`)

Ghost's `computer-use__get_app_state` failure was caused by an unhandled MCP
elicitation, not a Computer Use client/service protocol mismatch. The bundled
Computer Use MCP server requests per-app approval with
`elicitation/create` before the first observation. Troublemaker advertised no
elicitation capability, so its MCP SDK returned `-32601 Method not found`; the
server surfaced that response as the `get_app_state` tool error.

Troublemaker now advertises form elicitation only for a local stdio server named
`computer-use` with the `computer:use` scope. Its handler auto-accepts only the
empty `Allow ChatGPT to use ...?` form carrying persistent-app metadata. Forms
with fields, URL elicitations, unrelated messages, and nonpersistent requests
are declined. Other MCP servers continue to receive no elicitation capability.

The Mac doctor now calls `get_app_state` for Finder and requires both an
accessibility tree and screenshot. Listing the static tool catalog is no longer
considered a passing Computer Use check.

Verification:

- `npm run typecheck`
- `npm run build`
- `npm run test:mcp-computer-use-elicitation`
- `npm run test:mac-ghost-install`
- `npm run doctor:local-mac` against Ghost's workspace and port 3018
- restarted `com.tinyfatco.troublemaker-ghost`; health returned `ok`
- Ghost reconnected all ten `computer-use__*` tools, Slack Socket Mode, and
  Telegram polling
- a live local Ghost turn called `computer-use__get_app_state` for Finder,
  approved the constrained elicitation, and completed in 0.9 seconds
- live result reported CUA app version `1000366`, Finder window `Downloads`, a
  populated accessibility tree, and a screenshot; no UI mutation was requested
  or performed

No manual Computer Use action tools were exercised. The remaining security
boundary is deliberate: Ghost is a full host agent, but only the signed Codex
sandbox launcher and narrowly recognized per-app approval form receive automatic
approval.
