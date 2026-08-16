import Foundation

public enum DeepgramCommitReason: String, Codable, Sendable {
    case speechFinal = "speech_final"
    case speechFinalGrace = "speech_final_grace"
    case utteranceEnd = "utterance_end"
    case silenceDebounce = "silence_debounce"
    case finalize
}

public struct DeepgramCommitPolicy: Equatable, Sendable {
    public let silenceDebounceMs: UInt64
    public let speechFinalGraceMs: UInt64
    public let utteranceEndGraceMs: UInt64

    public static let pushToTalk = DeepgramCommitPolicy(
        silenceDebounceMs: 900,
        speechFinalGraceMs: 450,
        utteranceEndGraceMs: 0
    )
}

public enum DeepgramMobileContract {
    public static let sampleRate = 16_000
    public static let model = "nova-3"

    public static func streamingURL() -> URL {
        var components = URLComponents(string: "wss://api.deepgram.com/v1/listen")!
        components.queryItems = [
            URLQueryItem(name: "model", value: model),
            URLQueryItem(name: "punctuate", value: "true"),
            URLQueryItem(name: "smart_format", value: "true"),
            URLQueryItem(name: "interim_results", value: "true"),
            URLQueryItem(name: "diarize", value: "true"),
            URLQueryItem(name: "encoding", value: "linear16"),
            URLQueryItem(name: "sample_rate", value: String(sampleRate)),
            URLQueryItem(name: "channels", value: "1"),
            URLQueryItem(name: "endpointing", value: "650"),
            URLQueryItem(name: "utterance_end_ms", value: "1000"),
        ]
        return components.url!
    }

    public static func linear16Sample(from sample: Float) -> Int16 {
        let clipped = max(-1, min(1, sample))
        if clipped == -1 { return Int16.min }
        return Int16(clipped * Float(Int16.max))
    }
}
