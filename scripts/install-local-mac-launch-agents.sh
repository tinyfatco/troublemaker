#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"
GUI_DOMAIN="gui/$(id -u)"
PATH_VALUE="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

plist_set_base() {
	local plist="$1"
	local label="$2"
	/usr/libexec/PlistBuddy -c "Add :Label string $label" "$plist"
	/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "$plist"
	/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "$plist"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$plist"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string $PATH_VALUE" "$plist"
	/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$plist"
}

install_plist() {
	local plist="$1"
	local label="$2"
	launchctl bootout "$GUI_DOMAIN" "$plist" >/dev/null 2>&1 || true
	launchctl bootstrap "$GUI_DOMAIN" "$plist"
	launchctl enable "$GUI_DOMAIN/$label" >/dev/null 2>&1 || true
	launchctl kickstart -k "$GUI_DOMAIN/$label"
}

troublemaker_plist="$PLIST_DIR/com.tinyfatco.troublemaker-local.plist"
rm -f "$troublemaker_plist"
plist_set_base "$troublemaker_plist" "com.tinyfatco.troublemaker-local"
/usr/libexec/PlistBuddy -c "Add :WorkingDirectory string $PROJECT_ROOT" "$troublemaker_plist"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string $LOG_DIR/troublemaker-local.log" "$troublemaker_plist"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string $LOG_DIR/troublemaker-local.log" "$troublemaker_plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string /bin/bash" "$troublemaker_plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string -lc" "$troublemaker_plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:2 string exec npm run local:mac -- --no-build" "$troublemaker_plist"
chmod 644 "$troublemaker_plist"

install_plist "$troublemaker_plist" "com.tinyfatco.troublemaker-local"

echo "Installed and started:"
echo "  $troublemaker_plist"
echo ""
echo "Logs:"
echo "  $LOG_DIR/troublemaker-local.log"
