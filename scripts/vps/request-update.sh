#!/bin/sh
set -eu

REF="${1:-}"
case "$REF" in
	main|staging) ;;
	*)
		echo "usage: zip-request-update main|staging" >&2
		exit 2
		;;
esac

REQUEST_DIR="${ZIP_UPDATE_REQUEST_DIR:-/run/zip-updater}"
if [ ! -d "$REQUEST_DIR" ]; then
	echo "zip-request-update: request directory is unavailable" >&2
	exit 1
fi

touch "$REQUEST_DIR/$REF.request"
echo "Zip update to origin/$REF requested. The agent will restart when the candidate build is ready."
