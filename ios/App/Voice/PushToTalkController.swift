import Foundation

@MainActor
final class PushToTalkController {
    private let audio = AudioCaptureManager()
    private var client: DeepgramStreamingClient?
    private var sessionID: UUID?
    private var latestTranscript = ""
    private var failureMessage: String?

    func begin(
        apiKey: String,
        onPartial: @escaping @MainActor (String) -> Void,
        onError: @escaping @MainActor (String) -> Void
    ) async throws {
        let id = UUID()
        sessionID = id
        latestTranscript = ""
        failureMessage = nil
        let client = DeepgramStreamingClient(apiKey: apiKey)
        client.onTranscript = { [weak self] text in
            Task { @MainActor in
                guard self?.sessionID == id else { return }
                self?.latestTranscript = text
                onPartial(text)
            }
        }
        client.onError = { [weak self] message in
            Task { @MainActor in
                guard self?.sessionID == id else { return }
                self?.failureMessage = message
                onError(message)
            }
        }
        try await client.connect()
        guard sessionID == id else {
            await client.disconnect()
            throw CancellationError()
        }
        self.client = client
        try await audio.start { data in
            Task { try? await client.sendAudio(data.data) }
        }
    }

    func finish() async -> String {
        sessionID = nil
        audio.stop()
        guard let client else { return latestTranscript }
        let final = await client.finish()
        await client.disconnect()
        self.client = nil
        if failureMessage != nil { return "" }
        latestTranscript = final
        return final
    }

    func cancel() {
        sessionID = nil
        failureMessage = nil
        audio.stop()
        let client = self.client
        self.client = nil
        Task { await client?.disconnect() }
    }
}
