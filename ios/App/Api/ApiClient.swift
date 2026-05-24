import Foundation

/// REST client for crawdad-cf `/api/v2/*`. Streaming endpoints live in
/// `Sources/TroublemakerCore/Streams/`.
///
/// Server contract reference: crawdad-cf/src/v2/router.ts.
public actor ApiClient {
    public let baseURL: URL
    private let tokenStore: TokenStore
    private let oauth: OAuthClient
    /// Persisted across token refreshes so we don't re-register on every launch.
    /// Stored alongside tokens in the keychain in a future revision; for now,
    /// the host wires it in.
    private let clientID: String
    private let session: URLSession

    public init(
        baseURL: URL = URL(string: "https://crawdad.tinyfat.com")!,
        clientID: String,
        oauth: OAuthClient,
        tokenStore: TokenStore,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.clientID = clientID
        self.oauth = oauth
        self.tokenStore = tokenStore
        self.session = session
    }

    // MARK: - Token plumbing

    public func currentBearerToken() async throws -> String {
        guard let tokens = tokenStore.load() else { throw ApiError.notAuthenticated }
        if tokens.expiresAt > Date().addingTimeInterval(30) {
            return tokens.accessToken
        }
        guard let refresh = tokens.refreshToken else { throw ApiError.notAuthenticated }
        let refreshed = try await oauth.refresh(refresh, clientID: clientID)
        try tokenStore.save(refreshed)
        return refreshed.accessToken
    }

    public func authorizedRequest(
        _ path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        body: Data? = nil,
        contentType: String? = nil
    ) async throws -> URLRequest {
        // Build with URLComponents so query items stay in the URL.query slot
        // (not percent-encoded into the path, which made the server fall
        // through to the catch-all 405 branch).
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let leading = path.hasPrefix("/") ? path : "/" + path
        components.path = (components.path == "/" ? "" : components.path) + leading
        if !query.isEmpty { components.queryItems = query }
        var req = URLRequest(url: components.url!)
        req.httpMethod = method
        req.setValue("Bearer \(try await currentBearerToken())", forHTTPHeaderField: "Authorization")
        if let body { req.httpBody = body }
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return req
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(type, from: data)
    }

    // MARK: - Endpoints

    public func listAgents() async throws -> [Agent] {
        let req = try await authorizedRequest("api/v2/agents", method: "GET")
        let (data, resp) = try await session.data(for: req)
        try ApiClient.assertOK(resp, data)
        return try decode(AgentListResponse.self, from: data).agents
    }

    public func status(agentID: String) async throws -> WorkspaceStatus {
        let req = try await authorizedRequest("api/v2/agents/\(agentID)/status")
        let (data, resp) = try await session.data(for: req)
        try ApiClient.assertOK(resp, data)
        return try decode(WorkspaceStatus.self, from: data)
    }

    public func listFiles(agentID: String, path: String) async throws -> [FileNode] {
        let req = try await authorizedRequest(
            "api/v2/agents/\(agentID)/files",
            query: [.init(name: "path", value: path)]
        )
        let (data, resp) = try await session.data(for: req)
        try ApiClient.assertOK(resp, data)
        return try decode(FileListResponse.self, from: data).files ?? []
    }

    public func readFile(agentID: String, path: String) async throws -> String {
        let req = try await authorizedRequest(
            "api/v2/agents/\(agentID)/file",
            query: [.init(name: "path", value: path)]
        )
        let (data, resp) = try await session.data(for: req)
        try ApiClient.assertOK(resp, data)
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// `GET /api/v2/agents/:id/events?limit=N[&before=offset]` — backlog of
    /// the awareness/chat history. The server returns raw JSONL `lines` we
    /// parse via `AwarenessDecoder`.
    public func eventsBacklog(agentID: String, limit: Int = 50, before: Int? = nil) async throws -> AwarenessBacklog {
        var query: [URLQueryItem] = [.init(name: "limit", value: String(limit))]
        if let before { query.append(.init(name: "before", value: String(before))) }
        let req = try await authorizedRequest("api/v2/agents/\(agentID)/events", query: query)
        let (data, resp) = try await session.data(for: req)
        try ApiClient.assertOK(resp, data)
        return try decode(AwarenessBacklog.self, from: data)
    }

    public func stopActiveMessage(agentID: String, channelID: String = "web") async throws {
        let body = try JSONSerialization.data(withJSONObject: ["channelId": channelID])
        let req = try await authorizedRequest("api/v2/agents/\(agentID)/messages/stop", method: "POST", body: body, contentType: "application/json")
        let (data, resp) = try await session.data(for: req)
        try ApiClient.assertOK(resp, data)
    }

    static func assertOK(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { throw ApiError.notHTTP }
        guard (200..<300).contains(http.statusCode) else {
            throw ApiError.http(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
    }
}

public enum ApiError: Swift.Error, Equatable {
    case notAuthenticated
    case notHTTP
    case http(status: Int, body: String)
}
