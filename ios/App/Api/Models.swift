import Foundation

struct AgentEnrollment: Sendable {
    let displayName: String
    let baseURL: URL
    let routeAgentID: String
    let accessToken: String
    let deepgramAPIKey: String
}

enum MobileAPIError: Error, LocalizedError, Equatable {
    case invalidResponse
    case http(status: Int, body: String)
    case disconnected

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The agent returned an invalid response."
        case .http(let status, _):
            return AgentVerificationFailureText.httpStatus(status)
        case .disconnected:
            return "The agent connection closed."
        }
    }
}

struct SSEEvent: Sendable, Equatable {
    let data: String
    let id: String?
}
