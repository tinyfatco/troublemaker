#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_BUNDLE="$PROJECT_ROOT/build/Troublemaker.app"
INSTALL_PATH="/Applications/Troublemaker.app"
GUI_DOMAIN="gui/$(id -u)"
LEGACY_PLIST="$HOME/Library/LaunchAgents/com.tinyfatco.troublemaker-local.plist"

echo "Building Troublemaker server..."
(cd "$PROJECT_ROOT" && npm run build)

echo "Building Troublemaker web UI..."
(cd "$PROJECT_ROOT/ui" && npm run build)

echo "Building Troublemaker.app bundle..."
"$SCRIPT_DIR/build-mac-app.sh"

echo "Stopping legacy launch agent, if present..."
launchctl bootout "$GUI_DOMAIN" "$LEGACY_PLIST" >/dev/null 2>&1 || true
rm -f "$LEGACY_PLIST"

echo "Stopping existing Troublemaker.app instances..."
pkill -f "/Applications/Troublemaker.app/Contents/MacOS/Troublemaker" >/dev/null 2>&1 || true
pkill -f "$PROJECT_ROOT/build/Troublemaker.app/Contents/MacOS/Troublemaker" >/dev/null 2>&1 || true
pkill -f "$PROJECT_ROOT/dist/main.js --adapter=web,mcp" >/dev/null 2>&1 || true
pkill -f "/opt/homebrew/bin/peekaboo mcp --no-remote" >/dev/null 2>&1 || true

echo "Installing to /Applications..."
rm -rf "$INSTALL_PATH"
ditto "$APP_BUNDLE" "$INSTALL_PATH"
codesign --force --deep --sign - "$INSTALL_PATH" >/dev/null

echo "Launching Troublemaker.app..."
open "$INSTALL_PATH"

echo ""
echo "✓ Troublemaker is running from $INSTALL_PATH"
echo ""
echo "Local endpoints:"
echo "  UI:      http://127.0.0.1:${TROUBLEMAKER_PORT:-3002}"
echo "  Webhook: http://127.0.0.1:${TROUBLEMAKER_PORT:-3002}/input/webhook"
echo ""
echo "Grant permissions to Troublemaker in:"
echo "  System Settings -> Privacy & Security -> Accessibility"
echo "  System Settings -> Privacy & Security -> Screen & System Audio Recording"
