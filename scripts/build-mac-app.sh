#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_BUNDLE="$PROJECT_ROOT/build/Troublemaker.app"
INSTALL_APP="/Applications/Troublemaker.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
EXECUTABLE="$MACOS/Troublemaker"
INFO_PLIST="$CONTENTS/Info.plist"
SWIFT_SOURCE_DIR="$PROJECT_ROOT/mac/TroublemakerMac"
ICONSET="$PROJECT_ROOT/build/Troublemaker.iconset"
ICON_GENERATOR="$PROJECT_ROOT/build/generate-t-icon.swift"

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS" "$RESOURCES"

SWIFT_SOURCES=()
while IFS= read -r source; do
	SWIFT_SOURCES+=("$source")
done < <(find "$SWIFT_SOURCE_DIR" -name '*.swift' -print | sort)
if [ "${#SWIFT_SOURCES[@]}" -eq 0 ]; then
	echo "No Swift sources found in $SWIFT_SOURCE_DIR" >&2
	exit 1
fi

export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"
xcrun swiftc \
	-O \
	-framework AppKit \
	-framework AVFoundation \
	-framework AuthenticationServices \
	-framework Security \
	-framework SwiftUI \
	"${SWIFT_SOURCES[@]}" \
	-o "$EXECUTABLE"
chmod 755 "$EXECUTABLE"
printf "%s\n" "$PROJECT_ROOT" > "$RESOURCES/project-root"

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
cat > "$ICON_GENERATOR" <<'SWIFT'
import AppKit
import Foundation

let iconset = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let entries: [(String, CGFloat)] = [
	("icon_16x16.png", 16),
	("icon_16x16@2x.png", 32),
	("icon_32x32.png", 32),
	("icon_32x32@2x.png", 64),
	("icon_128x128.png", 128),
	("icon_128x128@2x.png", 256),
	("icon_256x256.png", 256),
	("icon_256x256@2x.png", 512),
	("icon_512x512.png", 512),
	("icon_512x512@2x.png", 1024),
]

func scaledRect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, size: CGFloat) -> NSRect {
	NSRect(
		x: x / 128 * size,
		y: (128 - y - height) / 128 * size,
		width: width / 128 * size,
		height: height / 128 * size
	)
}

for (name, size) in entries {
	let image = NSImage(size: NSSize(width: size, height: size))
	image.lockFocus()
	NSGraphicsContext.current?.imageInterpolation = .high
	NSColor.black.setFill()
	NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size), xRadius: size * 0.125, yRadius: size * 0.125).fill()
	NSColor.white.setFill()
	NSBezierPath(rect: scaledRect(x: 28, y: 24, width: 72, height: 20, size: size)).fill()
	NSBezierPath(rect: scaledRect(x: 48, y: 44, width: 32, height: 60, size: size)).fill()
	image.unlockFocus()

	guard let tiff = image.tiffRepresentation,
	      let bitmap = NSBitmapImageRep(data: tiff),
	      let png = bitmap.representation(using: .png, properties: [:]) else {
		exit(1)
	}
	try png.write(to: iconset.appendingPathComponent(name))
}
SWIFT
xcrun swift "$ICON_GENERATOR" "$ICONSET"
iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"

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
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Troublemaker</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.tinyfatco.troublemaker.oauth</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>tfat</string>
			</array>
		</dict>
	</array>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>15.0</string>
	<key>NSAppleEventsUsageDescription</key>
	<string>Troublemaker uses local automation tools to control apps when you ask it to.</string>
	<key>NSMicrophoneUsageDescription</key>
	<string>Troublemaker uses the microphone for voice-driven local agent commands.</string>
	<key>NSScreenCaptureUsageDescription</key>
	<string>Troublemaker uses Peekaboo to observe your screen for local computer-use automation.</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null

if [ "${TROUBLEMAKER_SKIP_INSTALL:-0}" != "1" ]; then
	rm -rf "$INSTALL_APP"
	ditto "$APP_BUNDLE" "$INSTALL_APP"
fi

echo "Built $APP_BUNDLE"
if [ "${TROUBLEMAKER_SKIP_INSTALL:-0}" != "1" ]; then
	echo "Installed $INSTALL_APP"
fi
