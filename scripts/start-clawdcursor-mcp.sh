#!/usr/bin/env bash
set -euo pipefail

PORT="${CLAWDCURSOR_PORT:-3847}"
LOG_FILE="${CLAWDCURSOR_LOG_FILE:-$HOME/Library/Logs/clawdcursor-agent.log}"
PID_FILE="${CLAWDCURSOR_PID_FILE:-$HOME/.clawdcursor/agent.pid}"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"

if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
	echo "Clawd Cursor MCP already running on :$PORT"
	exit 0
fi

if ! command -v clawdcursor >/dev/null 2>&1; then
	echo "clawdcursor command not found" >&2
	exit 1
fi

# Clawd Cursor v0.9.3 exits when daemonized with stdin closed. Keep stdin open
# with an inert pipe so the HTTP MCP server remains alive outside a terminal.
nohup bash -lc 'tail -f /dev/null | clawdcursor agent --no-llm' >"$LOG_FILE" 2>&1 &
echo "$!" >"$PID_FILE"

for _ in {1..60}; do
	if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
		echo "Clawd Cursor MCP started on :$PORT"
		exit 0
	fi
	sleep 0.25
done

echo "Clawd Cursor MCP did not become healthy on :$PORT" >&2
tail -80 "$LOG_FILE" >&2 || true
exit 1
