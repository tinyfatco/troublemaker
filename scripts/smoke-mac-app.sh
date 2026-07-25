#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${TROUBLEMAKER_APP_PATH:-/Applications/Troublemaker.app}"
STATUS_PATH="/tmp/troublemaker-peekaboo-app-smoke.json"

rm -f "$STATUS_PATH" /tmp/troublemaker-peekaboo-app-smoke.png

open -n -W "$APP_PATH" --args --smoke-peekaboo

if [ ! -f "$STATUS_PATH" ]; then
	echo "Missing smoke status: $STATUS_PATH" >&2
	exit 1
fi

node - "$STATUS_PATH" <<'NODE'
const fs = require("fs");
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
if (!status.success) {
	console.error(JSON.stringify(status, null, 2));
	process.exit(1);
}
console.log(`✓ Troublemaker.app Peekaboo MCP capture works (${status.toolCount} tools)`);
console.log(`  ${status.imagePath}`);
NODE
