#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${TROUBLEMAKER_ENV_FILE:-}"
if [ -n "$ENV_FILE" ]; then
	if [ ! -f "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
		echo "Troublemaker environment file is unavailable: $ENV_FILE" >&2
		exit 1
	fi
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_PROFILE="${TROUBLEMAKER_AGENT_PROFILE:-}"
AGENT_NAME="${TROUBLEMAKER_AGENT_NAME:-}"
CLOUD_AGENT_ID="${TROUBLEMAKER_CLOUD_AGENT_ID:-}"
TENANT_ID="${TROUBLEMAKER_TENANT_ID:-}"
CLOUD_BASE_URL="${TROUBLEMAKER_CLOUD_BASE_URL:-https://crawdad.tinyfat.com}"
APP_OWNED_RUNTIME="${TROUBLEMAKER_APP_OWNED_RUNTIME:-0}"
ALLOW_LOCAL_OPENAI_KEY="${TROUBLEMAKER_ALLOW_LOCAL_OPENAI_KEY:-0}"
REALTIME_AUTH_MODE="${TROUBLEMAKER_REALTIME_AUTH:-}"
LOCAL_AGENT_ID="${TROUBLEMAKER_LOCAL_AGENT_ID:-${CLOUD_AGENT_ID:-${AGENT_PROFILE:-local-desktop}}}"
SAFE_LOCAL_AGENT_ID="$(printf "%s" "$LOCAL_AGENT_ID" | tr -c '[:alnum:]_.-' '-')"
PROFILE_ACTIVE=0
if [ -n "$AGENT_PROFILE" ] || [ -n "$CLOUD_AGENT_ID" ] || [ -n "$TENANT_ID" ] || [ "$APP_OWNED_RUNTIME" = "1" ] || [ "$APP_OWNED_RUNTIME" = "true" ]; then
	PROFILE_ACTIVE=1
fi
if [ -n "${TROUBLEMAKER_WORKSPACE:-}" ]; then
	WORKSPACE_DIR="$TROUBLEMAKER_WORKSPACE"
elif [ "$PROFILE_ACTIVE" -eq 1 ]; then
	WORKSPACE_DIR="$HOME/Library/Application Support/Troublemaker/Agents/$SAFE_LOCAL_AGENT_ID/Workspace"
else
	WORKSPACE_DIR="$HOME/Library/Application Support/Troublemaker/Workspace"
fi
if [ -n "${TROUBLEMAKER_PORT:-}" ]; then
	PORT="$TROUBLEMAKER_PORT"
elif [ "$PROFILE_ACTIVE" -eq 1 ]; then
	PORT="3017"
else
	PORT="3002"
fi
HOST="${TROUBLEMAKER_HOST:-127.0.0.1}"
COMPUTER_USE_PLUGIN_DIR="${COMPUTER_USE_PLUGIN_DIR:-/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use}"
COMPUTER_USE_MCP_COMMAND="${COMPUTER_USE_MCP_COMMAND:-$COMPUTER_USE_PLUGIN_DIR/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient}"
CODEX_CLI_COMMAND="${CODEX_CLI_COMMAND:-$HOME/.local/bin/codex}"
CODEX_CUA_PROFILE="${CODEX_CUA_PROFILE:-ghost-cua}"
CODEX_CUA_PROFILE_FILE="$HOME/.codex/$CODEX_CUA_PROFILE.config.toml"
KEYCHAIN_SERVICE="${TROUBLEMAKER_KEYCHAIN_SERVICE:-com.tinyfatco.troublemaker.local}"
ADAPTERS="${TROUBLEMAKER_ADAPTERS:-web,mcp}"
BUILD=1

truthy() {
	case "${1:-}" in
		1|true|TRUE|yes|YES|on|ON)
			return 0
			;;
		*)
			return 1
			;;
	esac
}

local_realtime_auth() {
	case "$(printf "%s" "${1:-}" | tr '[:upper:]' '[:lower:]')" in
		local|direct)
			return 0
			;;
		*)
			return 1
			;;
	esac
}

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

if [ "$PROFILE_ACTIVE" -eq 1 ]; then
	if [ "$PORT" = "3002" ]; then
		echo "Refusing tenant-bound runtime on generic port 3002. Set TROUBLEMAKER_PORT to an app-owned port." >&2
		exit 2
	fi
	if [ "$WORKSPACE_DIR" = "$HOME/Library/Application Support/Troublemaker/Workspace" ]; then
		echo "Refusing tenant-bound runtime in generic Troublemaker workspace. Set TROUBLEMAKER_WORKSPACE to an agent-scoped path." >&2
		exit 2
	fi
fi

mkdir -p "$WORKSPACE_DIR"

if [ ! -f "$CODEX_CUA_PROFILE_FILE" ]; then
	mkdir -p "$(dirname "$CODEX_CUA_PROFILE_FILE")"
	printf 'default_permissions = ":danger-full-access"\n\n[permissions]\n' > "$CODEX_CUA_PROFILE_FILE"
	chmod 600 "$CODEX_CUA_PROFILE_FILE"
fi

load_keychain_secret() {
	local var_name="$1"
	shift
	if [ -n "${!var_name:-}" ]; then
		return
	fi
	local account value
	for account in "$@"; do
		value="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$account" -w 2>/dev/null || true)"
		if [ -n "$value" ]; then
			export "$var_name=$value"
			return
		fi
	done
}

load_keychain_secret FIREWORKS_API_KEY FIREWORKS_API_KEY
if [ -n "$CLOUD_AGENT_ID" ] && ! truthy "$ALLOW_LOCAL_OPENAI_KEY" && ! local_realtime_auth "$REALTIME_AUTH_MODE"; then
	unset OPENAI_API_KEY MOM_OPENAI_API_KEY
	export TROUBLEMAKER_REALTIME_AUTH="${TROUBLEMAKER_REALTIME_AUTH:-broker}"
else
	load_keychain_secret OPENAI_API_KEY OPENAI_API_KEY MOM_OPENAI_API_KEY
	load_keychain_secret MOM_OPENAI_API_KEY MOM_OPENAI_API_KEY OPENAI_API_KEY
fi
load_keychain_secret MOM_ELEVENLABS_API_KEY MOM_ELEVENLABS_API_KEY ELEVENLABS_API_KEY
load_keychain_secret MOM_ELEVENLABS_VOICE_ID MOM_ELEVENLABS_VOICE_ID ELEVENLABS_VOICE_ID
load_keychain_secret MOM_ELEVENLABS_MODEL_ID MOM_ELEVENLABS_MODEL_ID ELEVENLABS_MODEL_ID

if [ "$BUILD" -eq 1 ]; then
	echo "Building Troublemaker server..."
	(cd "$PROJECT_ROOT" && npm run build)

	echo "Building Troublemaker web UI..."
	(cd "$PROJECT_ROOT/ui" && npm run build)
fi

echo "Configuring local MCP providers..."
node --input-type=module - "$WORKSPACE_DIR" "$COMPUTER_USE_MCP_COMMAND" "$COMPUTER_USE_PLUGIN_DIR" "$CODEX_CLI_COMMAND" "$CODEX_CUA_PROFILE" "$AGENT_PROFILE" "$AGENT_NAME" "$LOCAL_AGENT_ID" "$CLOUD_AGENT_ID" "$TENANT_ID" "$CLOUD_BASE_URL" "$APP_OWNED_RUNTIME" <<'NODE'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const [
	workspaceDir,
	computerUseCommand,
	computerUseCwd,
	codexCommand,
	codexCuaProfile,
	agentProfile,
	agentName,
	localAgentId,
	cloudAgentId,
	tenantId,
	cloudBaseUrl,
	appOwnedRuntime,
] = process.argv.slice(2);
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
settings.mcpServers = servers.filter((server) => !["peekaboo", "computer-use"].includes(server?.alias));
settings.defaultProvider = settings.defaultProvider || "fireworks";
settings.defaultModel = settings.defaultModel || "accounts/fireworks/models/glm-5p1";
if (agentProfile || cloudAgentId || tenantId || appOwnedRuntime === "1" || appOwnedRuntime === "true") {
	settings.name = agentName || settings.name || "Local Desktop Agent";
	settings.display_mode = "desktop";
	settings.localAgentProfile = agentProfile || settings.localAgentProfile || "local-desktop";
	settings.localAgentId = localAgentId || settings.localAgentId || cloudAgentId || "local-desktop";
	settings.cloudAgentId = cloudAgentId || settings.cloudAgentId || null;
	settings.tenantId = tenantId || settings.tenantId || null;
	settings.cloudBaseUrl = cloudBaseUrl || settings.cloudBaseUrl || "https://crawdad.tinyfat.com";
	settings.appOwnedRuntime = true;
}

if (computerUseCommand && codexCommand && existsSync(computerUseCommand) && existsSync(computerUseCwd) && existsSync(codexCommand)) {
	settings.mcpServers.push({
		alias: "computer-use",
		transport: "stdio",
		command: codexCommand,
		args: [
			"sandbox",
			"-p", codexCuaProfile,
			"-P", ":danger-full-access",
			"-C", computerUseCwd,
			"--", computerUseCommand, "mcp",
		],
		cwd: computerUseCwd,
		scopes: ["computer:use", "accessibility:read", "accessibility:write"],
		addedBy: "scripts/run-local-mac.sh",
	});
} else {
	console.warn("  Codex Computer Use MCP or signed Codex CLI not found; install or update Codex.app");
}

writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`  ${settingsPath}`);
NODE

if [ ! -x "$COMPUTER_USE_MCP_COMMAND" ] || [ ! -x "$CODEX_CLI_COMMAND" ]; then
	echo ""
	echo "Note: Codex Computer Use MCP is unavailable."
	echo "Expected: $COMPUTER_USE_MCP_COMMAND"
	echo "Install or update Codex.app, then rerun this script."
	echo ""
fi

echo "Starting Troublemaker local on http://$HOST:$PORT"
exec node "$PROJECT_ROOT/dist/main.js" \
	--adapter="$ADAPTERS" \
	--host="$HOST" \
	--port="$PORT" \
	--ui="$PROJECT_ROOT/ui/dist" \
	--sandbox=host \
	"$WORKSPACE_DIR"
