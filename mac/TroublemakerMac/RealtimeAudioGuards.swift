import Foundation

struct OpenAIRealtimeSessionConfig {
	static let vadThreshold = NSDecimalNumber(string: "0.6")

	static func audioConfig(voiceName: String) -> [String: Any] {
		[
			"input": [
				"format": ["type": "audio/pcm", "rate": 24000],
				"noise_reduction": ["type": "far_field"],
				"turn_detection": turnDetectionConfig(),
				"transcription": ["model": "gpt-realtime-whisper"],
			],
			"output": [
				"format": ["type": "audio/pcm", "rate": 24000],
				"voice": voiceName,
				"speed": 1.0,
			],
		]
	}

	static func turnDetectionConfig() -> [String: Any] {
		[
			"type": "server_vad",
			"create_response": false,
			"interrupt_response": false,
			"prefix_padding_ms": 250,
			"silence_duration_ms": 450,
			"threshold": vadThreshold,
		]
	}
}

struct RealtimeMicSuppressionGate {
	private(set) var micSuppressed = false
	private(set) var armedAt: Date?
	private(set) var guardActive = false

	mutating func arm(armedAt: Date) {
		guardActive = true
		self.armedAt = armedAt
		micSuppressed = true
	}

	mutating func releaseAfterDelayIfNeeded(now: Date) {
		if let armedAt {
			if armedAt <= now {
				micSuppressed = false
			}
		} else {
			micSuppressed = false
		}
	}

	mutating func releaseForListening() {
		micSuppressed = false
		clearGuard()
	}

	mutating func reset() {
		micSuppressed = false
		clearGuard()
	}

	func isBargeInAllowed(now: Date) -> Bool {
		guard let armedAt else { return true }
		return now >= armedAt
	}

	private mutating func clearGuard() {
		armedAt = nil
		guardActive = false
	}
}
