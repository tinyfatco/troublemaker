#!/usr/bin/env bash
set -euo pipefail

PORT="${TROUBLEMAKER_PORT:-3002}"
CLAWDCURSOR_MCP_URL="${CLAWDCURSOR_MCP_URL:-http://127.0.0.1:3847/mcp}"
CLAWDCURSOR_TOKEN_FILE="${CLAWDCURSOR_TOKEN_FILE:-$HOME/.clawdcursor/token}"

ok() { printf "✓ %s\n" "$1"; }
warn() { printf "⚠ %s\n" "$1"; }
fail() { printf "✗ %s\n" "$1"; }

if command -v node >/dev/null 2>&1; then
	ok "node $(node --version)"
else
	fail "node is not installed"
fi

if command -v npm >/dev/null 2>&1; then
	ok "npm $(npm --version)"
else
	fail "npm is not installed"
fi

if command -v clawdcursor >/dev/null 2>&1; then
	ok "clawdcursor command found"
else
	warn "clawdcursor command not found"
fi

if curl -fsS "http://127.0.0.1:3848/health" >/dev/null 2>&1; then
	ok "Clawd Cursor native host is running on :3848"
	host_status="$(curl -fsS "http://127.0.0.1:3848/status" 2>/dev/null || true)"
	if printf "%s" "$host_status" | grep -q '"accessibility":true'; then
		ok "Clawd Cursor native Accessibility permission is granted"
	else
		warn "Clawd Cursor native Accessibility permission is not granted"
	fi
	if printf "%s" "$host_status" | grep -q '"screenRecording":true'; then
		ok "Clawd Cursor native Screen Recording permission is granted"
	else
		warn "Clawd Cursor native Screen Recording permission is not granted"
	fi
else
	warn "Clawd Cursor native host is not running on :3848"
fi

if [ -f "$CLAWDCURSOR_TOKEN_FILE" ]; then
	ok "Clawd Cursor token file exists"
else
	warn "Missing Clawd Cursor token file: $CLAWDCURSOR_TOKEN_FILE"
fi

if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
	ok "Troublemaker health is up on :$PORT"
else
	warn "Troublemaker health is not up on :$PORT"
fi

if [ -f "$CLAWDCURSOR_TOKEN_FILE" ]; then
		if curl -fsS -m 2 \
			-X POST "$CLAWDCURSOR_MCP_URL" \
			-H "Authorization: Bearer $(tr -d '\n' < "$CLAWDCURSOR_TOKEN_FILE")" \
			-H "Content-Type: application/json" \
			-H "Accept: application/json, text/event-stream" \
			-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' >/dev/null 2>&1; then
		ok "Clawd Cursor MCP responded"
	else
		warn "Clawd Cursor MCP did not respond at $CLAWDCURSOR_MCP_URL"
	fi
fi

echo ""
echo "Expected local endpoints:"
echo "  Troublemaker UI:       http://127.0.0.1:$PORT"
echo "  Yappatron webhook:     http://127.0.0.1:$PORT/input/yappatron"
echo "  Clawd Cursor MCP:      $CLAWDCURSOR_MCP_URL"
