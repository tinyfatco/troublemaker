#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/main.swift" <<'SWIFT'
import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
	if !condition() {
		fputs("FAIL: \(message)\n", stderr)
		exit(1)
	}
}

let turnDetection = OpenAIRealtimeSessionConfig.turnDetectionConfig()
require(turnDetection["create_response"] as? Bool == false, "Realtime VAD must not auto-create responses")
require(turnDetection["interrupt_response"] as? Bool == false, "Realtime VAD must not auto-interrupt responses")
require(turnDetection["threshold"] is NSDecimalNumber, "Realtime VAD threshold must be decimal-backed")

let sessionData = try JSONSerialization.data(withJSONObject: [
	"audio": OpenAIRealtimeSessionConfig.audioConfig(voiceName: "marin"),
])
let sessionJSON = String(data: sessionData, encoding: .utf8) ?? ""
require(sessionJSON.contains("\"threshold\":0.6"), "Realtime threshold must serialize as 0.6")
require(!sessionJSON.contains("0.599999"), "Realtime threshold must not serialize with binary-float tail")
require(sessionJSON.contains("\"voice\":\"marin\""), "Realtime voice should be configurable")

var gate = RealtimeMicSuppressionGate()
require(!gate.micSuppressed, "Mic starts unsuppressed")
require(gate.isBargeInAllowed(now: Date()), "Barge-in starts allowed")

gate.arm(armedAt: .distantFuture)
require(gate.micSuppressed, "Realtime playback suppresses mic")
require(gate.guardActive, "Realtime playback activates guard")
require(!gate.isBargeInAllowed(now: Date()), "Passive barge-in is disabled while playback is active")

gate.releaseForListening()
require(!gate.micSuppressed, "Listening releases mic suppression")
require(!gate.guardActive, "Listening clears guard")
require(gate.isBargeInAllowed(now: Date()), "Barge-in is allowed after listening resumes")

gate.arm(armedAt: .distantFuture)
gate.reset()
require(!gate.micSuppressed, "Reset releases mic suppression")
require(!gate.guardActive, "Reset clears guard")

print("mac realtime guard tests passed")
SWIFT

xcrun swiftc \
	"$PROJECT_ROOT/mac/TroublemakerMac/RealtimeAudioGuards.swift" \
	"$TMP_DIR/main.swift" \
	-o "$TMP_DIR/test-mac-realtime-guards"
"$TMP_DIR/test-mac-realtime-guards"
