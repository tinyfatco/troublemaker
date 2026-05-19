#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="${TROUBLEMAKER_WORKSPACE:-$HOME/Library/Application Support/Troublemaker/Workspace}"
PORT="${TROUBLEMAKER_PORT:-3002}"

ok() { printf "✓ %s\n" "$1"; }
warn() { printf "⚠ %s\n" "$1"; }
fail() { printf "✗ %s\n" "$1"; }

permission_granted() {
	local name="$1"
	local raw
	raw="$(cat)"
	PERMISSIONS_JSON="$raw" node - "$name" <<'NODE'
const name = process.argv[2];
try {
	const parsed = JSON.parse(process.env.PERMISSIONS_JSON || "");
	const permissions = parsed?.data?.permissions || [];
	const permission = permissions.find(item => item?.name === name);
	process.exit(permission?.isGranted === true ? 0 : 1);
} catch {
	process.exit(1);
}
NODE
}

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

if command -v peekaboo >/dev/null 2>&1; then
	ok "peekaboo $(peekaboo --version | sed 's/^Peekaboo //')"
else
	warn "peekaboo command not found"
fi

if command -v peekaboo >/dev/null 2>&1; then
	permissions="$(peekaboo permissions --json 2>/dev/null || true)"
	if printf "%s" "$permissions" | permission_granted "Accessibility"; then
		ok "Peekaboo Accessibility permission is granted"
	else
		warn "Peekaboo Accessibility permission is not granted"
	fi

	if printf "%s" "$permissions" | permission_granted "Screen Recording"; then
		ok "Peekaboo Screen Recording permission is granted"
	else
		warn "Peekaboo Screen Recording permission is not granted"
	fi

	if peekaboo tools --json >/dev/null 2>&1; then
		ok "Peekaboo tool catalog responded"
	else
		warn "Peekaboo tool catalog did not respond"
	fi

	if (cd "$PROJECT_ROOT" && node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
	command: "peekaboo",
	args: ["mcp"],
	stderr: "pipe",
});
const client = new Client({ name: "troublemaker-doctor", version: "1.0.0" }, { capabilities: {} });
try {
	await client.connect(transport);
	const tools = await client.listTools();
	if (!tools.tools.some(tool => tool.name === "see")) {
		throw new Error("missing see tool");
	}
} finally {
	await client.close().catch(() => {});
}
NODE
	); then
		ok "Peekaboo stdio MCP responded"
	else
		warn "Peekaboo stdio MCP did not respond"
	fi

	if node - "$WORKSPACE_DIR/settings.json" <<'NODE'
const fs = require("fs");
const settingsPath = process.argv[2];
try {
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const peekaboo = servers.find(server => server?.alias === "peekaboo");
	process.exit(peekaboo?.transport === "stdio" && peekaboo?.command ? 0 : 1);
} catch {
	process.exit(1);
}
NODE
	then
		ok "Troublemaker workspace is configured for Peekaboo stdio MCP"
	else
		warn "Troublemaker workspace is not configured for Peekaboo stdio MCP"
	fi
fi

if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
	ok "Troublemaker health is up on :$PORT"
else
	warn "Troublemaker health is not up on :$PORT"
fi

echo ""
echo "Expected local endpoints:"
echo "  Troublemaker UI:       http://127.0.0.1:$PORT"
echo "  Yappatron webhook:     http://127.0.0.1:$PORT/input/yappatron"
echo "  Peekaboo MCP:          peekaboo mcp (stdio child process)"
