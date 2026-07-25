import Foundation

/// `POST /api/v2/agents/:id/messages` — the user sends a turn, the server
/// streams the assistant response as SSE.
///
/// Wire format mirrors troublemaker/ui/src/hooks/useWebChat.ts (which is what
/// the actual server, crawdad-cf/src/v2/handlers/console.ts, accepts):
///   body: { "message": "<text>", "channelId": "<channel>" }
/// `channelId` is optional, defaults to "web" server-side. We pass "ios" so
/// the agent sees iOS-originated turns as their own column in the awareness
/// stream — useful context for the agent, even though there's no outbound
/// `ios` adapter (replies still come back inline via this same SSE stream).
public struct MessageStream {
    let api: ApiClient
    let sse: SSEClient
    public init(api: ApiClient, sse: SSEClient = SSEClient()) {
        self.api = api
        self.sse = sse
    }

    public struct Outgoing: Encodable {
        public let message: String
        public let channelId: String
        public init(message: String, channelId: String = "ios") {
            self.message = message
            self.channelId = channelId
        }
    }

    public func send(agentID: String, message: Outgoing) async throws -> AsyncThrowingStream<SSEEvent, Swift.Error> {
        let body = try JSONEncoder().encode(message)
        let req = try await api.authorizedRequest(
            "api/v2/agents/\(agentID)/messages",
            method: "POST",
            body: body,
            contentType: "application/json"
        )
        return sse.events(for: req)
    }
}
