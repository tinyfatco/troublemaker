#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="${TROUBLEMAKER_WORKSPACE:-$HOME/Library/Application Support/Troublemaker/Workspace}"
PORT="${TROUBLEMAKER_PORT:-3002}"
PEEKABOO_MCP_COMMAND="${PEEKABOO_MCP_COMMAND:-$(command -v peekaboo || true)}"
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

echo "Configuring local MCP providers..."
node --input-type=module - "$WORKSPACE_DIR" "$PEEKABOO_MCP_COMMAND" <<'NODE'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const [workspaceDir, peekabooCommand] = process.argv.slice(2);
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
settings.mcpServers = servers.filter((server) => server?.alias !== "peekaboo");
settings.defaultProvider = settings.defaultProvider || "fireworks";
settings.defaultModel = settings.defaultModel || "accounts/fireworks/models/glm-5p1";

if (peekabooCommand) {
	settings.mcpServers.push({
		alias: "peekaboo",
		transport: "stdio",
		command: peekabooCommand,
		args: ["mcp"],
		scopes: ["computer:use", "accessibility:read", "accessibility:write"],
		addedBy: "scripts/run-local-mac.sh",
	});
} else {
	console.warn("  peekaboo command not found; install with: brew install steipete/tap/peekaboo");
}

writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`  ${settingsPath}`);
NODE

if [ -z "$PEEKABOO_MCP_COMMAND" ]; then
	echo ""
	echo "Note: Peekaboo is not installed."
	echo "Run: brew install steipete/tap/peekaboo"
	echo "Then rerun this script."
	echo ""
fi

echo "Starting Troublemaker local on http://127.0.0.1:$PORT"
exec node "$PROJECT_ROOT/dist/main.js" \
	--adapter=web,mcp \
	--port="$PORT" \
	--ui="$PROJECT_ROOT/ui/dist" \
	--sandbox=host \
	"$WORKSPACE_DIR"
