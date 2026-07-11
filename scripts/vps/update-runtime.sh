#!/bin/sh
set -eu

REF="${1:-}"
case "$REF" in
	main|staging) ;;
	*)
		echo "zip-update: ref must be main or staging" >&2
		exit 2
		;;
esac

REPO=/opt/troublemaker
PREVIOUS=/opt/troublemaker-previous
CANDIDATE="/opt/troublemaker-candidate-$$"
FAILED="/opt/troublemaker-failed-$$"
REMOTE=https://github.com/tinyfatco/troublemaker.git
BUILD_HOME=/var/lib/zip-updater
HEALTH_URL=http://127.0.0.1:3002/health
SERVICE=zip-agent.service

exec 9>/run/lock/zip-update.lock
flock 9

cleanup() {
	if [ -n "${CANDIDATE:-}" ] && [ -d "$CANDIDATE" ]; then
		rm -rf "$CANDIDATE"
	fi
}
trap cleanup EXIT HUP INT TERM

rollback() {
	echo "zip-update: candidate failed activation; restoring the previous runtime" >&2
	systemctl stop "$SERVICE" || true
	if [ -d "$REPO" ]; then
		mv "$REPO" "$FAILED"
	fi
	if [ ! -d "$PREVIOUS" ]; then
		echo "zip-update: previous runtime is unavailable; manual intervention required" >&2
		return 1
	fi
	mv "$PREVIOUS" "$REPO"
	if ! systemctl start "$SERVICE"; then
		echo "zip-update: previous runtime did not start; manual intervention required" >&2
		return 1
	fi

	attempt=0
	while [ "$attempt" -lt 20 ]; do
		if systemctl is-active --quiet "$SERVICE" && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
			rm -rf "$FAILED"
			ROLLBACK_REVISION=$(runuser -u zip-builder -- git -C "$REPO" rev-parse --short HEAD)
			echo "zip-update: rollback healthy on $ROLLBACK_REVISION" >&2
			return 0
		fi
		attempt=$((attempt + 1))
		sleep 3
	done

	echo "zip-update: rollback failed health checks; manual intervention required" >&2
	return 1
}

install -d -m 0755 -o zip-builder -g zip-builder "$BUILD_HOME"
rm -rf "$CANDIDATE"
install -d -m 0755 -o zip-builder -g zip-builder "$CANDIDATE"
runuser -u zip-builder -- env HOME="$BUILD_HOME" git clone \
	--branch "$REF" --single-branch "$REMOTE" "$CANDIDATE"

runuser -u zip-builder -- env HOME="$BUILD_HOME" sh -c "
	set -eu
	cd '$CANDIDATE'
	umask 022
	npm ci --no-audit --no-fund
	NODE_OPTIONS=--max-old-space-size=700 npm run build
"

REVISION=$(runuser -u zip-builder -- git -C "$CANDIDATE" rev-parse HEAD)
SHORT_REVISION=$(printf '%s' "$REVISION" | cut -c1-7)
echo "zip-update: candidate $SHORT_REVISION built from origin/$REF"

systemctl stop "$SERVICE"
rm -rf "$PREVIOUS"
mv "$REPO" "$PREVIOUS"
if ! mv "$CANDIDATE" "$REPO"; then
	mv "$PREVIOUS" "$REPO"
	systemctl start "$SERVICE"
	exit 1
fi
CANDIDATE=

if ! systemctl start "$SERVICE"; then
	rollback || true
	exit 1
fi
healthy=false
attempt=0
while [ "$attempt" -lt 30 ]; do
	if systemctl is-active --quiet "$SERVICE" && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
		healthy=true
		break
	fi
	attempt=$((attempt + 1))
	sleep 3
done

if [ "$healthy" = true ]; then
	echo "zip-update: healthy on $SHORT_REVISION from origin/$REF"
	exit 0
fi

rollback || true
exit 1
