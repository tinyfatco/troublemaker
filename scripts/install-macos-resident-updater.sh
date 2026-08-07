#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_ROOT=""
RESIDENT_LABEL=""
RESIDENT_PLIST=""
HEALTH_URL=""
REPOSITORY=""
BUILD_UI=0

usage() {
	cat <<'EOF'
usage: install-macos-resident-updater.sh \
  --runtime-root /absolute/path \
  --resident-label com.example.resident \
  --resident-plist /absolute/path/resident.plist \
  --health-url http://127.0.0.1:3000/health \
  --repository /absolute/path/to/release.git \
  [--build-ui]
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--runtime-root) RUNTIME_ROOT="${2:-}"; shift 2 ;;
		--resident-label) RESIDENT_LABEL="${2:-}"; shift 2 ;;
		--resident-plist) RESIDENT_PLIST="${2:-}"; shift 2 ;;
		--health-url) HEALTH_URL="${2:-}"; shift 2 ;;
		--repository) REPOSITORY="${2:-}"; shift 2 ;;
		--build-ui) BUILD_UI=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
done

if [ -z "$RUNTIME_ROOT" ] || [ -z "$RESIDENT_LABEL" ] || [ -z "$RESIDENT_PLIST" ] ||
	[ -z "$HEALTH_URL" ] || [ -z "$REPOSITORY" ]; then
	usage >&2
	exit 2
fi
case "$RUNTIME_ROOT" in /|"$HOME"|"") echo "unsafe runtime root: $RUNTIME_ROOT" >&2; exit 2 ;; esac
case "$HEALTH_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "health URL must be loopback-only" >&2; exit 2 ;; esac
if [ ! -f "$RESIDENT_PLIST" ]; then
	echo "resident plist is unavailable: $RESIDENT_PLIST" >&2
	exit 1
fi
if [ "$(/usr/libexec/PlistBuddy -c 'Print:Label' "$RESIDENT_PLIST" 2>/dev/null)" != "$RESIDENT_LABEL" ]; then
	echo "resident plist label does not match --resident-label" >&2
	exit 1
fi
if ! /usr/bin/git ls-remote "$REPOSITORY" >/dev/null 2>&1; then
	echo "release repository is unavailable: $REPOSITORY" >&2
	exit 1
fi

TOOLS_DIR="$RUNTIME_ROOT/host-updater"
QUEUE_DIR="$TOOLS_DIR/queue"
STATE_DIR="$TOOLS_DIR/state"
LOG_DIR="$HOME/Library/Logs"
PLIST_DIR="$HOME/Library/LaunchAgents"
UPDATER_LABEL="$RESIDENT_LABEL.updater"
UPDATER_PLIST="$PLIST_DIR/$UPDATER_LABEL.plist"
CONFIG_PATH="$TOOLS_DIR/updater.conf"
UPDATER_PATH="$TOOLS_DIR/update-runtime"
REQUEST_PATH="$TOOLS_DIR/request-update"
GUI_DOMAIN="gui/$(id -u)"
NODE_DIR="$(dirname "$(command -v node)")"
NPM_DIR="$(dirname "$(command -v npm)")"
PATH_VALUE="$NODE_DIR:$NPM_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$TOOLS_DIR" "$QUEUE_DIR" "$STATE_DIR" "$LOG_DIR" "$PLIST_DIR"
chmod 0700 "$TOOLS_DIR" "$QUEUE_DIR" "$STATE_DIR"
install -m 0700 "$SCRIPT_DIR/macos-resident-updater.sh" "$UPDATER_PATH"
install -m 0700 "$SCRIPT_DIR/macos-resident-request-update.sh" "$REQUEST_PATH"

CONFIG_TMP="$CONFIG_PATH.tmp.$$"
umask 077
{
	printf 'RESIDENT_LABEL=%q\n' "$RESIDENT_LABEL"
	printf 'RESIDENT_PLIST=%q\n' "$RESIDENT_PLIST"
	printf 'HEALTH_URL=%q\n' "$HEALTH_URL"
	printf 'REPOSITORY=%q\n' "$REPOSITORY"
	printf 'RUNTIME_ROOT=%q\n' "$RUNTIME_ROOT"
	printf 'QUEUE_DIR=%q\n' "$QUEUE_DIR"
	printf 'BUILD_UI=%q\n' "$BUILD_UI"
	printf 'GIT_BIN=%q\n' "/usr/bin/git"
	printf 'NPM_BIN=%q\n' "$(command -v npm)"
} > "$CONFIG_TMP"
chmod 0600 "$CONFIG_TMP"
mv "$CONFIG_TMP" "$CONFIG_PATH"

PLIST_TMP="$UPDATER_PLIST.tmp.$$"
QUEUE_JSON="$(node -e 'process.stdout.write(JSON.stringify([process.argv[1]]))' "$QUEUE_DIR")"
ENVIRONMENT_JSON="$(node -e 'process.stdout.write(JSON.stringify({PATH: process.argv[1]}))' "$PATH_VALUE")"
/usr/bin/plutil -create xml1 "$PLIST_TMP"
/usr/bin/plutil -insert Label -string "$UPDATER_LABEL" "$PLIST_TMP"
/usr/bin/plutil -insert ProgramArguments -json '[]' "$PLIST_TMP"
/usr/bin/plutil -insert ProgramArguments.0 -string "$UPDATER_PATH" "$PLIST_TMP"
/usr/bin/plutil -insert ProgramArguments.1 -string "$CONFIG_PATH" "$PLIST_TMP"
/usr/bin/plutil -insert EnvironmentVariables -json "$ENVIRONMENT_JSON" "$PLIST_TMP"
/usr/bin/plutil -insert QueueDirectories -json "$QUEUE_JSON" "$PLIST_TMP"
/usr/bin/plutil -insert ProcessType -string Background "$PLIST_TMP"
/usr/bin/plutil -insert StandardOutPath -string "$LOG_DIR/$(basename "$UPDATER_LABEL").log" "$PLIST_TMP"
/usr/bin/plutil -insert StandardErrorPath -string "$LOG_DIR/$(basename "$UPDATER_LABEL").log" "$PLIST_TMP"
/usr/bin/plutil -lint "$PLIST_TMP" >/dev/null
chmod 0644 "$PLIST_TMP"
mv "$PLIST_TMP" "$UPDATER_PLIST"

/bin/launchctl bootout "$GUI_DOMAIN/$UPDATER_LABEL" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "$GUI_DOMAIN" "$UPDATER_PLIST"
/bin/launchctl enable "$GUI_DOMAIN/$UPDATER_LABEL" >/dev/null 2>&1 || true
/bin/launchctl kickstart -k "$GUI_DOMAIN/$UPDATER_LABEL" >/dev/null 2>&1 || true

echo "Installed independent resident updater:"
echo "  service: $UPDATER_LABEL"
echo "  request: $REQUEST_PATH $CONFIG_PATH <release-branch>"
echo "  log:     $LOG_DIR/$(basename "$UPDATER_LABEL").log"
