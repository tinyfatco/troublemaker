#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="${TROUBLEMAKER_WORKSPACE:-$HOME/Library/Application Support/Troublemaker/Workspace}"
PORT="${TROUBLEMAKER_PORT:-3002}"
CLAWDCURSOR_MCP_URL="${CLAWDCURSOR_MCP_URL:-http://127.0.0.1:3847/mcp}"
CLAWDCURSOR_TOKEN_FILE="${CLAWDCURSOR_TOKEN_FILE:-$HOME/.clawdcursor/token}"
CLAWDCURSOR_AUTOSTART="${CLAWDCURSOR_AUTOSTART:-1}"
KEYCHAIN_SERVICE="${TROUBLEMAKER_KEYCHAIN_SERVICE:-com.tinyfatco.troublemaker.local}"
BUILD=1

for arg in "$@"; do
	case "$arg" in
		--no-build)
			BUILD=0
			;;
		*)
			echo "Unknown argument: $arg" >&2
			echo "Usage: $0 [--no-build]" >&2
			exit 2
			;;
	esac
done

mkdir -p "$WORKSPACE_DIR"

if [ -z "${FIREWORKS_API_KEY:-}" ]; then
	FIREWORKS_API_KEY="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a FIREWORKS_API_KEY -w 2>/dev/null || true)"
	if [ -n "$FIREWORKS_API_KEY" ]; then
		export FIREWORKS_API_KEY
	fi
fi

if [ "$BUILD" -eq 1 ]; then
	echo "Building Troublemaker server..."
	(cd "$PROJECT_ROOT" && npm run build)

	echo "Building Troublemaker web UI..."
	(cd "$PROJECT_ROOT/ui" && npm run build)
fi

if [ "$CLAWDCURSOR_AUTOSTART" = "1" ]; then
	echo "Ensuring Clawd Cursor MCP is running..."
	"$SCRIPT_DIR/start-clawdcursor-mcp.sh"
fi

echo "Configuring local MCP providers..."
node --input-type=module - "$WORKSPACE_DIR" "$CLAWDCURSOR_MCP_URL" "$CLAWDCURSOR_TOKEN_FILE" <<'NODE'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const [workspaceDir, clawdUrl, clawdTokenFile] = process.argv.slice(2);
mkdirSync(workspaceDir, { recursive: true });

const settingsPath = join(workspaceDir, "settings.json");
let settings = {};
if (existsSync(settingsPath)) {
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		settings = {};
	}
}

const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
settings.mcpServers = servers.filter((server) => server?.alias !== "clawdcursor");
settings.defaultProvider = settings.defaultProvider || "fireworks";
settings.defaultModel = settings.defaultModel || "accounts/fireworks/models/glm-5p1";
settings.mcpServers.push({
	alias: "clawdcursor",
	url: clawdUrl,
	tokenFile: clawdTokenFile,
	scopes: ["computer:use", "accessibility:read", "accessibility:write"],
	addedBy: "scripts/run-local-mac.sh",
});

writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`  ${settingsPath}`);
NODE

if [ ! -f "$CLAWDCURSOR_TOKEN_FILE" ]; then
	echo ""
	echo "Note: Clawd Cursor token not found at $CLAWDCURSOR_TOKEN_FILE"
	echo "Run: clawdcursor agent --no-llm"
	echo "Then rerun this script after ~/.clawdcursor/token exists."
	echo ""
fi

echo "Starting Troublemaker local on http://127.0.0.1:$PORT"
exec node "$PROJECT_ROOT/dist/main.js" \
	--adapter=web,mcp \
	--port="$PORT" \
	--ui="$PROJECT_ROOT/ui/dist" \
	--sandbox=host \
	"$WORKSPACE_DIR"
