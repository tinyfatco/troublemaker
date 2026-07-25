import Foundation

/// `GET /api/v2/agents/:id/events/stream` — the awareness feed shown in the
/// right-hand pane on tinyfat.com/app.
public struct AwarenessStream {
    let api: ApiClient
    let sse: SSEClient
    public init(api: ApiClient, sse: SSEClient = SSEClient()) {
        self.api = api
        self.sse = sse
    }

    public func subscribe(agentID: String) async throws -> AsyncThrowingStream<SSEEvent, Swift.Error> {
        let req = try await api.authorizedRequest("api/v2/agents/\(agentID)/events/stream")
        return sse.events(for: req)
    }
}
