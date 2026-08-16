import Foundation

actor MobileAgentClient {
    let binding: AgentBinding
    private let token: String
    private let session: URLSession
    private let sse: SSEClient

    init(binding: AgentBinding, token: String, session: URLSession = .shared) {
        self.binding = binding
        self.token = token
        self.session = session
        self.sse = SSEClient(session: session)
    }

    func status() async throws -> AgentStatus {
        let status = try await probeStatus()
        try binding.verify(status)
        return status
    }

    func probeStatus() async throws -> AgentStatus {
        let request = try request("status")
        let (data, response) = try await session.data(for: request)
        try Self.assertOK(response, body: data)
        return try JSONDecoder.troublemakerMobile().decode(AgentStatus.self, from: data)
    }

    func backlog(limit: Int = 80) async throws -> ConversationBacklog {
        let request = try request("events", query: [
            .init(name: "limit", value: String(max(1, min(limit, 200)))),
            .init(name: "surface", value: "conversation"),
        ])
        let (data, response) = try await session.data(for: request)
        try Self.assertOK(response, body: data)
        return try JSONDecoder.troublemakerMobile().decode(ConversationBacklog.self, from: data)
    }

    func deliveryReceipts(for deliveryIDs: [String]) async throws -> [DeliveryReceipt] {
        let ids = Array(Set(deliveryIDs)).sorted()
        guard !ids.isEmpty else { return [] }
        precondition(ids.count <= 50, "Delivery receipt requests are bounded to 50 ids")
        let request = try request("deliveries", query: [
            .init(name: "ids", value: ids.joined(separator: ",")),
        ])
        let (data, response) = try await session.data(for: request)
        try Self.assertOK(response, body: data)
        return try JSONDecoder.troublemakerMobile().decode(DeliveryReceiptBatch.self, from: data).receipts
    }

    func live(after sequence: Int) throws -> AsyncThrowingStream<ConversationLiveEvent, Error> {
        var query = [URLQueryItem(name: "surface", value: "conversation")]
        if sequence > 0 { query.append(.init(name: "after", value: String(sequence))) }
        var request = try request("live", query: query)
        if sequence > 0 { request.setValue(String(sequence), forHTTPHeaderField: "Last-Event-ID") }
        let events = sse.events(for: request)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await event in events {
                        guard event.data != "[DONE]", let data = event.data.data(using: .utf8) else { continue }
                        continuation.yield(try JSONDecoder.troublemakerMobile().decode(ConversationLiveEvent.self, from: data))
                    }
                    throw MobileAPIError.disconnected
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func send(_ attempt: DeliveryAttempt) throws -> AsyncThrowingStream<TurnEvent, Error> {
        var request = try request("messages", method: "POST")
        request.httpBody = try JSONEncoder().encode(OutgoingTurn(
            message: attempt.exactText,
            deliveryId: attempt.id
        ))
        let events = sse.events(for: request)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await event in events {
                        if event.data == "[DONE]" { break }
                        guard let data = event.data.data(using: .utf8) else { continue }
                        continuation.yield(try JSONDecoder.troublemakerMobile().decode(TurnEvent.self, from: data))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func stop() async throws {
        var request = try request("messages/stop", method: "POST")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["channelId": "ios"])
        let (data, response) = try await session.data(for: request)
        try Self.assertOK(response, body: data)
    }

    private func request(
        _ suffix: String,
        method: String = "GET",
        query: [URLQueryItem] = []
    ) throws -> URLRequest {
        var request = URLRequest(url: try binding.consoleURL(suffix, query: query))
        request.httpMethod = method
        request.timeoutInterval = method == "GET" ? 30 : 600
        request.setValue("conversation", forHTTPHeaderField: "X-Troublemaker-Surface")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if method != "GET" { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }

    private static func assertOK(_ response: URLResponse, body: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw MobileAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let exact = String(data: body.prefix(4_096), encoding: .utf8) ?? ""
            throw MobileAPIError.http(status: http.statusCode, body: exact)
        }
    }
}
