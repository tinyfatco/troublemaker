#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${1:-}"
if [ -z "$CONFIG_PATH" ] || [ "$#" -ne 1 ]; then
	echo "usage: $0 /path/to/updater.conf" >&2
	exit 2
fi
if [ ! -r "$CONFIG_PATH" ]; then
	echo "resident-updater: config is unavailable: $CONFIG_PATH" >&2
	exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG_PATH"

: "${RESIDENT_LABEL:?RESIDENT_LABEL is required}"
: "${RESIDENT_PLIST:?RESIDENT_PLIST is required}"
: "${HEALTH_URL:?HEALTH_URL is required}"
: "${REPOSITORY:?REPOSITORY is required}"
: "${RUNTIME_ROOT:?RUNTIME_ROOT is required}"
: "${QUEUE_DIR:?QUEUE_DIR is required}"

case "$RUNTIME_ROOT" in
	/|"$HOME"|"")
		echo "resident-updater: refusing unsafe runtime root: $RUNTIME_ROOT" >&2
		exit 2
		;;
esac
case "$HEALTH_URL" in
	http://127.0.0.1:*|http://localhost:*) ;;
	*)
		echo "resident-updater: health URL must be loopback-only" >&2
		exit 2
		;;
esac

GIT_BIN="${GIT_BIN:-/usr/bin/git}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-/bin/launchctl}"
CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
PLUTIL_BIN="${PLUTIL_BIN:-/usr/bin/plutil}"
PLIST_BUDDY_BIN="${PLIST_BUDDY_BIN:-/usr/libexec/PlistBuddy}"
RUNNER_RELATIVE_PATH="${RUNNER_RELATIVE_PATH:-scripts/run-local-mac.sh}"
RUNNER_ARGUMENT_INDEX="${RUNNER_ARGUMENT_INDEX:-1}"
BUILD_UI="${BUILD_UI:-0}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"
STABILITY_SECONDS="${STABILITY_SECONDS:-5}"
GUI_DOMAIN="${GUI_DOMAIN:-gui/$(id -u)}"

STATE_DIR="$RUNTIME_ROOT/host-updater/state"
RELEASES_DIR="$RUNTIME_ROOT/releases"
FAILED_DIR="$RUNTIME_ROOT/failed-releases"
LOCK_DIR="$STATE_DIR/update.lock"
SERVICE_TARGET="$GUI_DOMAIN/$RESIDENT_LABEL"

mkdir -p "$STATE_DIR" "$RELEASES_DIR" "$FAILED_DIR" "$QUEUE_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	echo "resident-updater: another update is already running"
	exit 0
fi

REQUEST_PROCESSING=""
CANDIDATE_DIR=""
ROLLBACK_PLIST=""
ACTIVATION_STARTED=0
UPDATE_SUCCEEDED=0

service_pid() {
	"$LAUNCHCTL_BIN" print "$SERVICE_TARGET" 2>/dev/null |
		awk '/^[[:space:]]*pid =/ { print $3; exit }'
}

service_healthy() {
	"$LAUNCHCTL_BIN" print "$SERVICE_TARGET" >/dev/null 2>&1 &&
		"$CURL_BIN" -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1
}

wait_for_service_exit() {
	local attempt
	attempt=0
	while [ "$attempt" -lt 20 ]; do
		if ! "$LAUNCHCTL_BIN" print "$SERVICE_TARGET" >/dev/null 2>&1; then
			return 0
		fi
		attempt=$((attempt + 1))
		sleep 1
	done
	return 1
}

wait_for_health() {
	local attempt
	attempt=0
	while [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; do
		if service_healthy; then
			return 0
		fi
		attempt=$((attempt + 1))
		sleep "$HEALTH_INTERVAL_SECONDS"
	done
	return 1
}

install_plist_atomically() {
	local source_plist temp_plist
	source_plist="$1"
	temp_plist="$RESIDENT_PLIST.updater.$$"
	cp -p "$source_plist" "$temp_plist"
	chmod 0644 "$temp_plist"
	mv "$temp_plist" "$RESIDENT_PLIST"
}

rollback_runtime() {
	local rollback_pid
	if [ -z "$ROLLBACK_PLIST" ] || [ ! -f "$ROLLBACK_PLIST" ]; then
		echo "resident-updater: rollback plist is unavailable; manual recovery is required" >&2
		return 1
	fi

	echo "resident-updater: activation failed; restoring the previous runtime" >&2
	"$LAUNCHCTL_BIN" bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
	wait_for_service_exit || true
	install_plist_atomically "$ROLLBACK_PLIST"
	if ! "$LAUNCHCTL_BIN" bootstrap "$GUI_DOMAIN" "$RESIDENT_PLIST"; then
		echo "resident-updater: previous runtime did not bootstrap" >&2
		return 1
	fi
	"$LAUNCHCTL_BIN" enable "$SERVICE_TARGET" >/dev/null 2>&1 || true
	"$LAUNCHCTL_BIN" kickstart -k "$SERVICE_TARGET" >/dev/null 2>&1 || true
	if ! wait_for_health; then
		echo "resident-updater: previous runtime failed health checks" >&2
		return 1
	fi
	rollback_pid="$(service_pid)"
	printf 'rolledBackAt=%s\npid=%s\nplist=%s\n' \
		"$(date -u +%FT%TZ)" "$rollback_pid" "$ROLLBACK_PLIST" > "$STATE_DIR/last-rollback"
	echo "resident-updater: rollback is healthy on pid $rollback_pid" >&2
	return 0
}

cleanup() {
	local status="$?" failed_target
	trap - EXIT HUP INT TERM

	if [ "$status" -ne 0 ] && [ "$ACTIVATION_STARTED" -eq 1 ]; then
		rollback_runtime || true
	fi

	if [ "$status" -ne 0 ] && [ -n "$CANDIDATE_DIR" ] && [ -d "$CANDIDATE_DIR" ]; then
		failed_target="$FAILED_DIR/$(basename "$CANDIDATE_DIR")-$(date -u +%Y%m%dT%H%M%SZ)"
		mv "$CANDIDATE_DIR" "$failed_target" 2>/dev/null || true
	fi

	if [ -n "$REQUEST_PROCESSING" ] && [ -f "$REQUEST_PROCESSING" ]; then
		if [ "$status" -eq 0 ] && [ "$UPDATE_SUCCEEDED" -eq 1 ]; then
			rm -f "$REQUEST_PROCESSING"
		else
			mv "$REQUEST_PROCESSING" "$FAILED_DIR/$(basename "$REQUEST_PROCESSING").failed" 2>/dev/null || true
		fi
	fi

	rmdir "$LOCK_DIR" 2>/dev/null || true
	exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

REQUEST_FILE="$(find "$QUEUE_DIR" -maxdepth 1 -type f -name 'request.*' -print | LC_ALL=C sort | head -n 1 || true)"
if [ -z "$REQUEST_FILE" ]; then
	UPDATE_SUCCEEDED=1
	exit 0
fi

REQUEST_PROCESSING="$STATE_DIR/processing.$$.request"
mv "$REQUEST_FILE" "$REQUEST_PROCESSING"
IFS=$'\t' read -r REF REQUESTED_COMMIT < "$REQUEST_PROCESSING"

if ! "$GIT_BIN" check-ref-format --branch "$REF" >/dev/null 2>&1 ||
	! printf '%s\n' "$REQUESTED_COMMIT" | grep -Eq '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'; then
	echo "resident-updater: malformed update request" >&2
	exit 1
fi

SHORT_COMMIT="$(printf '%s' "$REQUESTED_COMMIT" | cut -c1-12)"
CANDIDATE_DIR="$RELEASES_DIR/source-$SHORT_COMMIT-$(date -u +%Y%m%dT%H%M%SZ)-$$"
echo "resident-updater: building $REF at $SHORT_COMMIT"

"$GIT_BIN" clone --no-local --branch "$REF" --single-branch "$REPOSITORY" "$CANDIDATE_DIR"
ACTUAL_COMMIT="$("$GIT_BIN" -C "$CANDIDATE_DIR" rev-parse HEAD)"
if [ "$ACTUAL_COMMIT" != "$REQUESTED_COMMIT" ]; then
	echo "resident-updater: release branch changed after the request was queued" >&2
	exit 1
fi

(
	cd "$CANDIDATE_DIR"
	env HOME="${BUILD_HOME:-$HOME}" "$NPM_BIN" ci --no-audit --no-fund
	env HOME="${BUILD_HOME:-$HOME}" NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}" "$NPM_BIN" run build
	if [ "$BUILD_UI" = "1" ] && [ -f ui/package-lock.json ]; then
		env HOME="${BUILD_HOME:-$HOME}" "$NPM_BIN" --prefix ui ci --no-audit --no-fund
		env HOME="${BUILD_HOME:-$HOME}" NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}" "$NPM_BIN" --prefix ui run build
	fi
)

if [ ! -x "$CANDIDATE_DIR/$RUNNER_RELATIVE_PATH" ]; then
	echo "resident-updater: candidate runner is unavailable: $RUNNER_RELATIVE_PATH" >&2
	exit 1
fi
if [ -n "$("$GIT_BIN" -C "$CANDIDATE_DIR" status --porcelain)" ]; then
	echo "resident-updater: candidate checkout became dirty during the build" >&2
	exit 1
fi

CANDIDATE_PLIST="$STATE_DIR/candidate.$$.plist"
cp -p "$RESIDENT_PLIST" "$CANDIDATE_PLIST"
"$PLIST_BUDDY_BIN" -c "Set :WorkingDirectory $CANDIDATE_DIR" "$CANDIDATE_PLIST"
"$PLIST_BUDDY_BIN" -c "Set :ProgramArguments:$RUNNER_ARGUMENT_INDEX $CANDIDATE_DIR/$RUNNER_RELATIVE_PATH" "$CANDIDATE_PLIST"
"$PLUTIL_BIN" -lint "$CANDIDATE_PLIST" >/dev/null

ROLLBACK_PLIST="$STATE_DIR/previous.$(date -u +%Y%m%dT%H%M%SZ).plist"
cp -p "$RESIDENT_PLIST" "$ROLLBACK_PLIST"
install_plist_atomically "$CANDIDATE_PLIST"
rm -f "$CANDIDATE_PLIST"

ACTIVATION_STARTED=1
"$LAUNCHCTL_BIN" bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true
if ! wait_for_service_exit; then
	echo "resident-updater: previous runtime did not exit cleanly" >&2
	exit 1
fi
if ! "$LAUNCHCTL_BIN" bootstrap "$GUI_DOMAIN" "$RESIDENT_PLIST"; then
	echo "resident-updater: candidate did not bootstrap" >&2
	exit 1
fi
"$LAUNCHCTL_BIN" enable "$SERVICE_TARGET" >/dev/null 2>&1 || true
"$LAUNCHCTL_BIN" kickstart -k "$SERVICE_TARGET" >/dev/null 2>&1 || true

if ! wait_for_health; then
	echo "resident-updater: candidate failed health checks" >&2
	exit 1
fi
FIRST_PID="$(service_pid)"
sleep "$STABILITY_SECONDS"
if ! service_healthy; then
	echo "resident-updater: candidate became unhealthy during the stability window" >&2
	exit 1
fi
STABLE_PID="$(service_pid)"
if [ -z "$FIRST_PID" ] || [ "$FIRST_PID" != "$STABLE_PID" ]; then
	echo "resident-updater: candidate restarted during the stability window" >&2
	exit 1
fi

printf 'activatedAt=%s\nref=%s\ncommit=%s\npid=%s\nruntime=%s\nrollbackPlist=%s\n' \
	"$(date -u +%FT%TZ)" "$REF" "$ACTUAL_COMMIT" "$STABLE_PID" "$CANDIDATE_DIR" "$ROLLBACK_PLIST" > "$STATE_DIR/last-success"

ACTIVATION_STARTED=0
UPDATE_SUCCEEDED=1
echo "resident-updater: healthy on $SHORT_COMMIT with pid $STABLE_PID"
