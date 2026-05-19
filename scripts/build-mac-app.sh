#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_BUNDLE="$PROJECT_ROOT/build/Troublemaker.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
EXECUTABLE="$MACOS/Troublemaker"
INFO_PLIST="$CONTENTS/Info.plist"

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS" "$RESOURCES"

swiftc "$PROJECT_ROOT/mac/TroublemakerLauncher.swift" -o "$EXECUTABLE"
chmod 755 "$EXECUTABLE"
printf "%s\n" "$PROJECT_ROOT" > "$RESOURCES/project-root"

cat > "$INFO_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>Troublemaker</string>
	<key>CFBundleExecutable</key>
	<string>Troublemaker</string>
	<key>CFBundleIdentifier</key>
	<string>com.tinyfatco.troublemaker</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Troublemaker</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>15.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSAppleEventsUsageDescription</key>
	<string>Troublemaker uses local automation tools to control apps when you ask it to.</string>
	<key>NSScreenCaptureUsageDescription</key>
	<string>Troublemaker uses Peekaboo to observe your screen for local computer-use automation.</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null

echo "Built $APP_BUNDLE"
