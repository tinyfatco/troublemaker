#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_BUNDLE="$PROJECT_ROOT/build/Troublemaker.app"
INSTALL_PATH="/Applications/Troublemaker.app"
INSTALLED_EXECUTABLE="$INSTALL_PATH/Contents/MacOS/Troublemaker"
GUI_DOMAIN="gui/$(id -u)"
LEGACY_PLIST="$HOME/Library/LaunchAgents/com.tinyfatco.troublemaker-local.plist"
LOCAL_JOB_LABEL="com.tinyfatco.troublemaker.app.local"

wait_for_troublemaker_to_stop() {
	for _ in {1..50}; do
		if ! pgrep -x Troublemaker >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.1
	done
	return 1
}

stop_running_troublemaker() {
	launchctl remove "$LOCAL_JOB_LABEL" >/dev/null 2>&1 || true
	if ! pgrep -x Troublemaker >/dev/null 2>&1; then
		return 0
	fi

	osascript -e 'tell application id "com.tinyfatco.troublemaker" to quit' 2>/dev/null || true
	if wait_for_troublemaker_to_stop; then
		return 0
	fi

	pkill -TERM -x Troublemaker || true
	wait_for_troublemaker_to_stop
}

stop_stale_project_runtime() {
	local runtime_pattern="$PROJECT_ROOT/dist/main.js --adapter=web,mcp"
	local runtime_pids
	runtime_pids="$(pgrep -f "$runtime_pattern" || true)"
	if [ -z "$runtime_pids" ]; then
		return 0
	fi

	echo "Stopping stale Troublemaker runtime from this checkout..."
	while IFS= read -r runtime_pid; do
		[ -n "$runtime_pid" ] && kill -TERM "$runtime_pid" 2>/dev/null || true
	done <<< "$runtime_pids"
}

launch_troublemaker_bundle() {
	local bundle_path="$1"
	local executable_path="$bundle_path/Contents/MacOS/Troublemaker"

	if codesign -dv --verbose=4 "$bundle_path" 2>&1 | grep -q 'Signature=adhoc'; then
		launchctl remove "$LOCAL_JOB_LABEL" >/dev/null 2>&1 || true
		launchctl submit -l "$LOCAL_JOB_LABEL" -- "$executable_path"
	else
		open "$bundle_path"
	fi
}

BACKUP_DIR=""
BACKUP_PATH=""
FAILED_PATH=""
INSTALL_IN_PROGRESS=0

rollback_install() {
	local guard_code="${1:-1}"
	trap - ERR INT TERM
	stop_running_troublemaker || true

	if [ -n "$FAILED_PATH" ] && [ -d "$INSTALL_PATH" ] && [ ! -e "$FAILED_PATH" ]; then
		mv "$INSTALL_PATH" "$FAILED_PATH"
	fi

	if [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ] && [ ! -e "$INSTALL_PATH" ]; then
		mv "$BACKUP_PATH" "$INSTALL_PATH"
		launch_troublemaker_bundle "$INSTALL_PATH" || true
		echo "The previous Troublemaker bundle was restored." >&2
	fi

	exit "$guard_code"
}

handle_unexpected_install_failure() {
	local failure_code=$?
	if [ "$INSTALL_IN_PROGRESS" = "1" ]; then
		echo "Error: install interrupted; rolling back." >&2
		rollback_install "$failure_code"
	fi
	exit "$failure_code"
}

echo "Building Troublemaker server..."
(cd "$PROJECT_ROOT" && npm run build)

echo "Building Troublemaker web UI..."
(cd "$PROJECT_ROOT/ui" && npm run build)

echo "Building Troublemaker.app bundle..."
TROUBLEMAKER_SKIP_INSTALL=1 "$SCRIPT_DIR/build-mac-app.sh"

echo "Stopping legacy launch agent, if present..."
launchctl bootout "$GUI_DOMAIN" "$LEGACY_PLIST" >/dev/null 2>&1 || true
rm -f "$LEGACY_PLIST"

if pgrep -x Troublemaker >/dev/null 2>&1; then
	echo "Stopping the running Troublemaker..."
	if ! stop_running_troublemaker; then
		echo "Error: Troublemaker did not stop cleanly." >&2
		exit 1
	fi
fi
stop_stale_project_runtime

echo "Installing to /Applications..."
BACKUP_DIR="$(mktemp -d /tmp/troublemaker-install.XXXXXX)"
BACKUP_PATH="$BACKUP_DIR/Troublemaker.app.previous"
FAILED_PATH="$BACKUP_DIR/Troublemaker.app.failed"
INSTALL_IN_PROGRESS=1
trap handle_unexpected_install_failure ERR INT TERM

if [ -d "$INSTALL_PATH" ]; then
	mv "$INSTALL_PATH" "$BACKUP_PATH"
fi

if ! ditto "$APP_BUNDLE" "$INSTALL_PATH"; then
	echo "Error: install failed." >&2
	rollback_install 1
fi

xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
xattr -dr com.apple.provenance "$INSTALL_PATH" 2>/dev/null || true

if ! codesign --verify --deep --strict "$INSTALL_PATH"; then
	echo "Error: installed signature verification failed." >&2
	rollback_install 1
fi

HOST_ARCHITECTURE="$(uname -m)"
if ! lipo "$INSTALLED_EXECUTABLE" -verify_arch "$HOST_ARCHITECTURE"; then
	echo "Error: installed Troublemaker does not support this Mac's $HOST_ARCHITECTURE architecture." >&2
	rollback_install 1
fi

LAUNCH_SERVICES_REGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LAUNCH_SERVICES_REGISTER" ]; then
	"$LAUNCH_SERVICES_REGISTER" -f "$INSTALL_PATH"
fi

echo "Launching Troublemaker..."
launch_troublemaker_bundle "$INSTALL_PATH"

for _ in {1..100}; do
	if pgrep -x Troublemaker >/dev/null 2>&1; then
		break
	fi
	sleep 0.1
done

if ! pgrep -x Troublemaker >/dev/null 2>&1; then
	echo "Error: the updated app did not launch." >&2
	rollback_install 1
fi

# Allow first-launch state to settle, then require one process from the exact
# installed bundle. This catches stale Launch Services launches and wrong-arch
# copies before the previous bundle is discarded.
sleep 2
RUNNING_PID="$(pgrep -x Troublemaker | head -n 1)"
PROCESS_COUNT="$(pgrep -x Troublemaker | wc -l | tr -d ' ')"
if [ -z "$RUNNING_PID" ] || [ "$PROCESS_COUNT" != "1" ]; then
	echo "Error: Troublemaker did not settle to one running process." >&2
	rollback_install 1
fi

RUNNING_EXECUTABLE="$(ps -p "$RUNNING_PID" -o command=)"
if [ "$RUNNING_EXECUTABLE" != "$INSTALLED_EXECUTABLE" ]; then
	echo "Error: Troublemaker launched from an unexpected bundle: $RUNNING_EXECUTABLE" >&2
	rollback_install 1
fi

INSTALL_IN_PROGRESS=0
trap - ERR INT TERM

echo ""
echo "✓ Troublemaker is running from $INSTALL_PATH"
echo "✓ Running PID: $RUNNING_PID"
echo "✓ Previous bundle backup: $BACKUP_PATH"
echo ""
echo "Local endpoints:"
echo "  UI:      http://127.0.0.1:${TROUBLEMAKER_PORT:-3002}"
echo "  Webhook: http://127.0.0.1:${TROUBLEMAKER_PORT:-3002}/input/webhook"
echo ""
echo "On the first install, or after an ad-hoc binary changes, review permissions in:"
echo "  System Settings -> Privacy & Security -> Microphone"
echo "  System Settings -> Privacy & Security -> Accessibility"
echo "  System Settings -> Privacy & Security -> Screen & System Audio Recording"
echo ""
echo "Run npm run doctor:local-mac to verify runtime and Computer Use health."
