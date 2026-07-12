#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="${TROUBLEMAKER_WORKSPACE:-$HOME/Library/Application Support/Troublemaker/Workspace}"
PORT="${TROUBLEMAKER_PORT:-3002}"
COMPUTER_USE_PLUGIN_DIR="${COMPUTER_USE_PLUGIN_DIR:-/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use}"
COMPUTER_USE_MCP_COMMAND="${COMPUTER_USE_MCP_COMMAND:-$COMPUTER_USE_PLUGIN_DIR/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient}"
CODEX_CLI_COMMAND="${CODEX_CLI_COMMAND:-$HOME/.local/bin/codex}"
CODEX_CUA_PROFILE="${CODEX_CUA_PROFILE:-ghost-cua}"

ok() { printf "✓ %s\n" "$1"; }
warn() { printf "⚠ %s\n" "$1"; }
fail() { printf "✗ %s\n" "$1"; }

if command -v node >/dev/null 2>&1; then
	ok "node $(node --version)"
else
	fail "node is not installed"
fi

if command -v npm >/dev/null 2>&1; then
	ok "npm $(npm --version)"
else
	fail "npm is not installed"
fi

if [ -x "$COMPUTER_USE_MCP_COMMAND" ] && [ -d "$COMPUTER_USE_PLUGIN_DIR" ]; then
	ok "Codex Computer Use MCP client is installed"
else
	warn "Codex Computer Use MCP client is unavailable"
fi

computer_use_mcp_config="$(node - "$WORKSPACE_DIR/settings.json" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const settingsPath = process.argv[2];
try {
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const server = servers.find(entry => entry?.alias === "computer-use");
	if (server?.transport !== "stdio" || !server.command) process.exit(1);
	process.stdout.write(JSON.stringify({
		command: server.command,
		args: Array.isArray(server.args) ? server.args : ["mcp"],
		cwd: server.cwd,
		env: server.env && typeof server.env === "object" ? server.env : {},
	}));
} catch {
	process.exit(1);
}
NODE
)"

if [ -n "$computer_use_mcp_config" ]; then
	ok "Troublemaker workspace is configured for Computer Use stdio MCP"
else
	warn "Troublemaker workspace is not configured for Computer Use stdio MCP"
	computer_use_mcp_config="$(jq -nc \
		--arg command "$CODEX_CLI_COMMAND" \
		--arg cwd "$COMPUTER_USE_PLUGIN_DIR" \
		--arg client "$COMPUTER_USE_MCP_COMMAND" \
		--arg profile "$CODEX_CUA_PROFILE" \
		'{command:$command,args:["sandbox","-p",$profile,"-P",":danger-full-access","-C",$cwd,"--",$client,"mcp"],cwd:$cwd,env:{}}')"
fi

if (cd "$PROJECT_ROOT" && COMPUTER_USE_MCP_CONFIG="$computer_use_mcp_config" node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = JSON.parse(process.env.COMPUTER_USE_MCP_CONFIG);
const transport = new StdioClientTransport({
	command: config.command,
	args: config.args,
	cwd: config.cwd,
	env: { ...process.env, ...(config.env || {}) },
	stderr: "pipe",
});
const client = new Client({ name: "troublemaker-doctor", version: "1.0.0" }, { capabilities: {} });
try {
	await client.connect(transport);
	const { tools } = await client.listTools();
	const names = new Set(tools.map(tool => tool.name));
	for (const required of ["list_apps", "get_app_state", "click", "type_text"]) {
		if (!names.has(required)) throw new Error(`missing ${required} tool`);
	}
	const result = await client.callTool({ name: "list_apps", arguments: {} });
	if (result.isError === true) throw new Error("list_apps returned an error");
} finally {
	await client.close().catch(() => {});
}
NODE
); then
	ok "Computer Use stdio MCP responded with application-control tools"
else
	warn "Computer Use stdio MCP did not respond correctly"
fi

if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
	ok "Troublemaker health is up on :$PORT"
else
	warn "Troublemaker health is not up on :$PORT"
fi

echo ""
echo "Expected local endpoints:"
echo "  Troublemaker UI:       http://127.0.0.1:$PORT"
echo "  Input webhook:         http://127.0.0.1:$PORT/input/webhook"
echo "  Computer Use MCP:      SkyComputerUseClient mcp (stdio child process)"
