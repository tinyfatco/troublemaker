#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"
SUPPORT_DIR="$HOME/Library/Application Support/Troublemaker/Ghost"
WORKSPACE_DIR="$SUPPORT_DIR/Workspace"
ENV_FILE="$SUPPORT_DIR/ghost.env"
RUNTIME_LABEL="com.tinyfatco.troublemaker-ghost"
TUNNEL_LABEL="com.tinyfatco.troublemaker-ghost-relay"
RUNTIME_PLIST="$PLIST_DIR/$RUNTIME_LABEL.plist"
TUNNEL_PLIST="$PLIST_DIR/$TUNNEL_LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"
PORT="${GHOST_PORT:-3018}"
RELAY_PORT="${GHOST_RELAY_PORT:-3333}"
PATH_VALUE="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

test -f "$ENV_FILE" || { echo "Missing Ghost secrets file: $ENV_FILE" >&2; exit 1; }
chmod 600 "$ENV_FILE"
mkdir -p "$PLIST_DIR" "$LOG_DIR" "$WORKSPACE_DIR"

echo "Building Troublemaker..."
(cd "$PROJECT_ROOT" && npm run build)
(cd "$PROJECT_ROOT/ui" && npm run build)

write_runtime_plist() {
	rm -f "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :Label string $RUNTIME_LABEL" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :WorkingDirectory string $PROJECT_ROOT" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $LOG_DIR/troublemaker-ghost.log" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $LOG_DIR/troublemaker-ghost.log" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string $PATH_VALUE" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TROUBLEMAKER_ENV_FILE string $ENV_FILE" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TROUBLEMAKER_WORKSPACE string $WORKSPACE_DIR" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TROUBLEMAKER_HOST string 127.0.0.1" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TROUBLEMAKER_PORT string $PORT" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TROUBLEMAKER_AGENT_PROFILE string ghost" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TROUBLEMAKER_AGENT_NAME string Ghost" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TROUBLEMAKER_LOCAL_AGENT_ID string ghost-mac" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:TROUBLEMAKER_ADAPTERS string web,mcp,slack:socket,telegram:polling" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string /bin/bash" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string $PROJECT_ROOT/scripts/run-local-mac.sh" "$RUNTIME_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:2 string --no-build" "$RUNTIME_PLIST"
	chmod 600 "$RUNTIME_PLIST"
}

write_tunnel_plist() {
	rm -f "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :Label string $TUNNEL_LABEL" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $LOG_DIR/troublemaker-ghost-relay.log" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $LOG_DIR/troublemaker-ghost-relay.log" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string /usr/bin/ssh" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string -NT" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:2 string -o" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:3 string BatchMode=yes" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:4 string -o" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:5 string ExitOnForwardFailure=yes" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:6 string -o" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:7 string ServerAliveInterval=30" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:8 string -o" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:9 string ServerAliveCountMax=3" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:10 string -R" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:11 string 127.0.0.1:$RELAY_PORT:127.0.0.1:$PORT" "$TUNNEL_PLIST"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments:12 string tiny-bat" "$TUNNEL_PLIST"
	chmod 600 "$TUNNEL_PLIST"
}

install_job() {
	local plist="$1"
	local label="$2"
	launchctl bootout "$GUI_DOMAIN" "$plist" >/dev/null 2>&1 || true
	launchctl bootstrap "$GUI_DOMAIN" "$plist"
	launchctl enable "$GUI_DOMAIN/$label" >/dev/null 2>&1 || true
	launchctl kickstart -k "$GUI_DOMAIN/$label"
}

write_runtime_plist
write_tunnel_plist
install_job "$RUNTIME_PLIST" "$RUNTIME_LABEL"
install_job "$TUNNEL_PLIST" "$TUNNEL_LABEL"

echo "Ghost installed on 127.0.0.1:$PORT with tiny-bat relay port $RELAY_PORT."
