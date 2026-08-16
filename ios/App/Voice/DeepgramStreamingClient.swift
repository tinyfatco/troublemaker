import Foundation

final class DeepgramStreamingClient: @unchecked Sendable {
    enum ClientError: Error, LocalizedError {
        case missingAPIKey
        case connectionFailed(String)
        case notConnected

        var errorDescription: String? {
            switch self {
            case .missingAPIKey: return "A Deepgram API key is required for push-to-talk."
            case .connectionFailed(let reason): return "Transcription connection failed: \(reason)"
            case .notConnected: return "Transcription is not connected."
            }
        }
    }

    private struct Message: Decodable {
        struct Channel: Decodable {
            struct Alternative: Decodable { let transcript: String }
            let alternatives: [Alternative]
        }
        let type: String?
        let channel: Channel?
        let is_final: Bool?
        let speech_final: Bool?
        let from_finalize: Bool?
        let message: String?
    }

    var onTranscript: (@Sendable (String) -> Void)?
    var onError: (@Sendable (String) -> Void)?

    private let apiKey: String
    private var session: URLSession?
    private var delegate: WebSocketOpenDelegate?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?
    private var finalSegments: [String] = []
    private var interim = ""
    private var finalizeContinuation: CheckedContinuation<String, Never>?
    private var finalizeTimeout: Task<Void, Never>?
    private var connected = false

    init(apiKey: String) {
        self.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func connect() async throws {
        guard !apiKey.isEmpty else { throw ClientError.missingAPIKey }
        var request = URLRequest(url: DeepgramMobileContract.streamingURL())
        request.setValue("Token \(apiKey)", forHTTPHeaderField: "Authorization")
        let delegate = WebSocketOpenDelegate()
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        let socket = session.webSocketTask(with: request)
        self.delegate = delegate
        self.session = session
        self.socket = socket
        socket.resume()
        guard await delegate.waitForOpen(timeout: 10) else {
            throw ClientError.connectionFailed(delegate.lastError ?? "Timed out")
        }
        connected = true
        startReceiving()
        startKeepAlive()
    }

    func sendAudio(_ data: Data) async throws {
        guard connected, let socket else { throw ClientError.notConnected }
        try await socket.send(.data(data))
    }

    func finish() async -> String {
        guard connected, let socket else { return transcript }
        return await withCheckedContinuation { continuation in
            finalizeContinuation?.resume(returning: transcript)
            finalizeContinuation = continuation
            finalizeTimeout?.cancel()
            finalizeTimeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 900_000_000)
                self?.completeFinalize()
            }
            Task { [weak self] in
                do { try await socket.send(.string("{\"type\":\"Finalize\"}")) }
                catch { self?.completeFinalize() }
            }
        }
    }

    func disconnect() async {
        connected = false
        receiveTask?.cancel()
        keepAliveTask?.cancel()
        finalizeTimeout?.cancel()
        finalizeContinuation?.resume(returning: transcript)
        finalizeContinuation = nil
        if let socket {
            try? await socket.send(.string("{\"type\":\"CloseStream\"}"))
            socket.cancel(with: .goingAway, reason: nil)
        }
        self.socket = nil
        session?.invalidateAndCancel()
        session = nil
        delegate = nil
    }

    var transcript: String {
        let final = finalSegments.joined(separator: " ")
        if interim.isEmpty { return final }
        return final.isEmpty ? interim : "\(final) \(interim)"
    }

    private func startReceiving() {
        receiveTask = Task { [weak self] in
            while !Task.isCancelled, let self, let socket = self.socket {
                do {
                    switch try await socket.receive() {
                    case .string(let text): self.handle(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) { self.handle(text) }
                    @unknown default: break
                    }
                } catch {
                    if !Task.isCancelled {
                        self.connected = false
                        self.onError?(error.localizedDescription)
                    }
                    return
                }
            }
        }
    }

    private func startKeepAlive() {
        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                guard let self, self.connected, let socket = self.socket else { return }
                try? await socket.send(.string("{\"type\":\"KeepAlive\"}"))
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONDecoder().decode(Message.self, from: data) else { return }
        if message.type == "Error" {
            onError?(message.message ?? "Transcription failed.")
            return
        }
        guard message.type == "Results", let alternative = message.channel?.alternatives.first else { return }
        if message.is_final == true {
            interim = ""
            if !alternative.transcript.isEmpty { finalSegments.append(alternative.transcript) }
        } else {
            interim = alternative.transcript
        }
        onTranscript?(transcript)
        if message.from_finalize == true { completeFinalize() }
    }

    private func completeFinalize() {
        finalizeTimeout?.cancel()
        finalizeTimeout = nil
        guard let continuation = finalizeContinuation else { return }
        finalizeContinuation = nil
        continuation.resume(returning: transcript)
    }
}

private final class WebSocketOpenDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var result: Bool?
    private(set) var lastError: String?

    func waitForOpen(timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(returning: result)
                return
            }
            self.continuation = continuation
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish(false, error: "Timed out after \(Int(timeout)) seconds")
            }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        finish(true)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error { finish(false, error: error.localizedDescription) }
    }

    private func finish(_ value: Bool, error: String? = nil) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        if let error { lastError = error }
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }
}
