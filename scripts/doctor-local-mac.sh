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
		ok "Peekaboo shell Screen Recording is not the app-owned TCC source"
	fi

	if peekaboo tools --json >/dev/null 2>&1; then
		ok "Peekaboo tool catalog responded"
	else
		warn "Peekaboo tool catalog did not respond"
	fi

	peekaboo_mcp_config="$(node - "$WORKSPACE_DIR/settings.json" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const settingsPath = process.argv[2];
try {
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
	const peekaboo = servers.find(server => server?.alias === "peekaboo");
	if (peekaboo?.transport !== "stdio" || !peekaboo.command) process.exit(1);
	process.stdout.write(JSON.stringify({
		command: peekaboo.command,
		args: Array.isArray(peekaboo.args) ? peekaboo.args : ["mcp", "--no-remote"],
		env: peekaboo.env && typeof peekaboo.env === "object" ? peekaboo.env : {},
	}));
} catch {
	process.exit(1);
}
NODE
)"

	if [ -n "$peekaboo_mcp_config" ]; then
		ok "Troublemaker workspace is configured for Peekaboo stdio MCP"
	else
		warn "Troublemaker workspace is not configured for Peekaboo stdio MCP"
		peekaboo_mcp_config='{"command":"peekaboo","args":["mcp","--no-remote"],"env":{"PEEKABOO_NO_REMOTE":"1"}}'
	fi

	if (cd "$PROJECT_ROOT" && PEEKABOO_MCP_CONFIG="$peekaboo_mcp_config" node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = JSON.parse(process.env.PEEKABOO_MCP_CONFIG);
const transport = new StdioClientTransport({
	command: config.command,
	args: config.args,
	env: { ...process.env, ...(config.env || {}) },
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

	run_shell_capture_smoke() {
		(cd "$PROJECT_ROOT" && PEEKABOO_MCP_CONFIG="$peekaboo_mcp_config" node --input-type=module <<'NODE'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = JSON.parse(process.env.PEEKABOO_MCP_CONFIG);
const transport = new StdioClientTransport({
	command: config.command,
	args: config.args,
	env: { ...process.env, ...(config.env || {}) },
	stderr: "pipe",
});
const client = new Client({ name: "troublemaker-doctor", version: "1.0.0" }, { capabilities: {} });
try {
	await client.connect(transport);
	const result = await client.callTool({
		name: "image",
		arguments: {
			app_target: "screen:0",
			path: "/tmp/troublemaker-peekaboo-doctor.png",
			format: "png",
		},
	});
	if (result.isError === true) {
		const message = Array.isArray(result.content)
			? result.content.map(part => part?.text).filter(Boolean).join("\n")
			: "image tool returned an error";
		console.error(message);
		process.exitCode = 1;
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	await client.close().catch(() => {});
}
NODE
		)
	}

	if [ "${TROUBLEMAKER_LAUNCHED_BY_APP:-}" = "1" ]; then
		if run_shell_capture_smoke; then
			ok "Peekaboo stdio MCP screen capture works inside Troublemaker.app"
		else
			warn "Peekaboo stdio MCP screen capture is blocked inside Troublemaker.app"
		fi
	elif [ -d "/Applications/Troublemaker.app" ] && [ -x "$PROJECT_ROOT/scripts/smoke-mac-app.sh" ]; then
		if "$PROJECT_ROOT/scripts/smoke-mac-app.sh" >/dev/null 2>&1; then
			ok "Troublemaker.app Peekaboo MCP screen capture works"
		else
			warn "Troublemaker.app Peekaboo MCP screen capture is blocked"
		fi
	else
		warn "Troublemaker.app is not installed; run ./run-dev.sh to test app-owned Screen Recording"
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
echo "  Input webhook:         http://127.0.0.1:$PORT/input/webhook"
echo "  Peekaboo MCP:          peekaboo mcp --no-remote (stdio child process)"
