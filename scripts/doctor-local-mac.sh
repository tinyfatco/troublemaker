#!/usr/bin/env bash
set -euo pipefail

PORT="${TROUBLEMAKER_PORT:-3002}"

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

if command -v peekaboo >/dev/null 2>&1; then
	ok "peekaboo $(peekaboo --version | sed 's/^Peekaboo //')"
else
	warn "peekaboo command not found"
fi

if command -v peekaboo >/dev/null 2>&1; then
	permissions="$(peekaboo permissions --json 2>/dev/null || true)"
	if printf "%s" "$permissions" | grep -q '"name" : "Accessibility"' &&
		printf "%s" "$permissions" | grep -A6 '"name" : "Accessibility"' | grep -q '"isGranted" : true'; then
		ok "Peekaboo Accessibility permission is granted"
	else
		warn "Peekaboo Accessibility permission is not granted"
	fi

	if printf "%s" "$permissions" | grep -q '"name" : "Screen Recording"' &&
		printf "%s" "$permissions" | grep -A6 '"name" : "Screen Recording"' | grep -q '"isGranted" : true'; then
		ok "Peekaboo Screen Recording permission is granted"
	else
		warn "Peekaboo Screen Recording permission is not granted"
	fi

	if peekaboo tools --json >/dev/null 2>&1; then
		ok "Peekaboo tool catalog responded"
	else
		warn "Peekaboo tool catalog did not respond"
	fi
fi

if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
	ok "Troublemaker health is up on :$PORT"
else
	warn "Troublemaker health is not up on :$PORT"
fi

echo ""
echo "Expected local endpoints:"
echo "  Troublemaker UI:       http://127.0.0.1:$PORT"
echo "  Yappatron webhook:     http://127.0.0.1:$PORT/input/yappatron"
echo "  Peekaboo MCP:          peekaboo mcp (stdio child process)"
