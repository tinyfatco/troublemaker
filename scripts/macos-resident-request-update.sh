#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${1:-}"
REF="${2:-}"

if [ -z "$CONFIG_PATH" ] || [ -z "$REF" ] || [ "$#" -ne 2 ]; then
	echo "usage: $0 /path/to/updater.conf branch" >&2
	exit 2
fi

if [ ! -r "$CONFIG_PATH" ]; then
	echo "resident-update-request: config is unavailable: $CONFIG_PATH" >&2
	exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG_PATH"

: "${REPOSITORY:?REPOSITORY is required}"
: "${QUEUE_DIR:?QUEUE_DIR is required}"
GIT_BIN="${GIT_BIN:-/usr/bin/git}"

if ! "$GIT_BIN" check-ref-format --branch "$REF" >/dev/null 2>&1; then
	echo "resident-update-request: invalid branch: $REF" >&2
	exit 2
fi

if [ ! -d "$QUEUE_DIR" ] || [ ! -w "$QUEUE_DIR" ]; then
	echo "resident-update-request: queue is unavailable: $QUEUE_DIR" >&2
	exit 1
fi

REMOTE_MATCHES="$("$GIT_BIN" ls-remote --exit-code "$REPOSITORY" "refs/heads/$REF" 2>/dev/null || true)"
REMOTE_COMMIT="$(printf '%s\n' "$REMOTE_MATCHES" | awk 'NF >= 2 { print $1 }')"
MATCH_COUNT="$(printf '%s\n' "$REMOTE_COMMIT" | awk 'NF { count += 1 } END { print count + 0 }')"

if [ "$MATCH_COUNT" -ne 1 ] || ! printf '%s\n' "$REMOTE_COMMIT" | grep -Eq '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'; then
	echo "resident-update-request: branch is missing or ambiguous in the release repository: $REF" >&2
	exit 1
fi

umask 077
REQUEST_TMP="$(mktemp "$QUEUE_DIR/.request.XXXXXX")"
cleanup() {
	rm -f "$REQUEST_TMP"
}
trap cleanup EXIT HUP INT TERM

printf '%s\t%s\n' "$REF" "$REMOTE_COMMIT" > "$REQUEST_TMP"
REQUEST_PATH="$QUEUE_DIR/request.$(date -u +%Y%m%dT%H%M%SZ).$$"
mv "$REQUEST_TMP" "$REQUEST_PATH"
REQUEST_TMP=""
trap - EXIT HUP INT TERM

printf 'Resident update queued: %s at %.12s\n' "$REF" "$REMOTE_COMMIT"
