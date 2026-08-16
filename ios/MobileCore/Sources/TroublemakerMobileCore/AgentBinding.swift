import Foundation

public struct AgentBinding: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let displayName: String
    public let baseURL: URL
    public let routeAgentID: String
    public let subjectAgentID: String
    public let credentialAccount: String

    public init(
        id: String = UUID().uuidString,
        displayName: String,
        baseURL: URL,
        routeAgentID: String,
        subjectAgentID: String,
        credentialAccount: String? = nil
    ) throws {
        guard Self.isSafeIdentifier(id), Self.isSafeIdentifier(routeAgentID),
              Self.isSafeIdentifier(subjectAgentID) else {
            throw AgentBindingError.invalidIdentifier
        }
        guard Self.isAllowedBaseURL(baseURL) else {
            throw AgentBindingError.insecureBaseURL
        }
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw AgentBindingError.missingDisplayName }

        self.id = id
        self.displayName = name
        self.baseURL = baseURL
        self.routeAgentID = routeAgentID
        self.subjectAgentID = subjectAgentID
        self.credentialAccount = credentialAccount ?? "agent.\(id)"
    }

    public func consoleURL(_ suffix: String, query: [URLQueryItem] = []) throws -> URL {
        guard !suffix.contains("..") else { throw AgentBindingError.invalidPath }
        var url = baseURL
        for component in ["api", "v2", "agents", routeAgentID] {
            url.appendPathComponent(component)
        }
        for component in suffix.split(separator: "/") where !component.isEmpty {
            url.appendPathComponent(String(component))
        }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw AgentBindingError.invalidPath
        }
        if !query.isEmpty { components.queryItems = query }
        guard let result = components.url else { throw AgentBindingError.invalidPath }
        return result
    }

    public func verify(_ status: AgentStatus) throws {
        guard status.agentId == subjectAgentID else {
            throw AgentBindingError.identityMismatch(expected: subjectAgentID, actual: status.agentId)
        }
    }

    public static func isAllowedBaseURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return false }
        if scheme == "https" { return true }
        return scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)
    }

    public static func isSafeIdentifier(_ value: String) -> Bool {
        guard (1...128).contains(value.count) else { return false }
        return value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || "-_.:".unicodeScalars.contains($0)
        }
    }
}

public struct AgentStatus: Codable, Equatable, Sendable {
    public let agentId: String
    public let agentName: String
    public let workspaceReady: Bool
    public let capabilities: [String: Bool]?

    public init(
        agentId: String,
        agentName: String,
        workspaceReady: Bool,
        capabilities: [String: Bool]? = nil
    ) {
        self.agentId = agentId
        self.agentName = agentName
        self.workspaceReady = workspaceReady
        self.capabilities = capabilities
    }
}

public enum AgentBindingError: Error, Equatable, LocalizedError {
    case invalidIdentifier
    case insecureBaseURL
    case missingDisplayName
    case invalidPath
    case identityMismatch(expected: String, actual: String)

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier: "The agent identifier is invalid."
        case .insecureBaseURL: "Agent connections require HTTPS, except on this device."
        case .missingDisplayName: "The agent needs a display name."
        case .invalidPath: "The agent route is invalid."
        case .identityMismatch: "The endpoint returned a different agent identity."
        }
    }
}

public enum AgentEnrollmentField: String, CaseIterable, Hashable, Sendable {
    case displayName
    case endpoint
    case routeAgentID
    case capability
}

/// Pure enrollment validation shared by the iPhone form and deterministic
/// tests. Capability text is only normalized in memory; it is never included
/// in an error, description, log, or persisted binding.
public struct AgentEnrollmentValidation: Equatable, Sendable {
    public let displayName: String
    public let baseURL: URL?
    public let routeAgentID: String
    public let capability: String
    private let errors: [AgentEnrollmentField: String]

    public init(
        displayName: String,
        endpoint: String,
        routeAgentID: String,
        capability: String
    ) {
        let normalizedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRouteAgentID = routeAgentID.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedCapability = capability.trimmingCharacters(in: .whitespacesAndNewlines)
        var errors: [AgentEnrollmentField: String] = [:]

        if normalizedName.isEmpty {
            errors[.displayName] = "Enter a display name."
        }

        let candidateURL = URL(string: normalizedEndpoint)
        let endpointIsComplete = candidateURL?.host?.isEmpty == false
            && candidateURL?.user == nil
            && candidateURL?.password == nil
            && candidateURL?.query == nil
            && candidateURL?.fragment == nil
            && candidateURL.map(AgentBinding.isAllowedBaseURL) == true
        if !endpointIsComplete {
            errors[.endpoint] = "Enter a complete private HTTPS endpoint."
        }

        if normalizedRouteAgentID.isEmpty {
            errors[.routeAgentID] = "Enter the exact route agent ID."
        } else if !AgentBinding.isSafeIdentifier(normalizedRouteAgentID) {
            errors[.routeAgentID] = "Use only letters, numbers, -, _, ., or : in the route agent ID."
        }

        if normalizedCapability.isEmpty {
            errors[.capability] = "Paste the existing agent capability."
        }

        self.displayName = normalizedName
        self.baseURL = endpointIsComplete ? candidateURL : nil
        self.routeAgentID = normalizedRouteAgentID
        self.capability = normalizedCapability
        self.errors = errors
    }

    public var isValid: Bool { errors.isEmpty }

    public var firstInvalidField: AgentEnrollmentField? {
        AgentEnrollmentField.allCases.first { errors[$0] != nil }
    }

    public func error(for field: AgentEnrollmentField) -> String? {
        errors[field]
    }
}

/// Stable, non-secret verification failures for the enrollment surface. Raw
/// provider bodies can contain deployment detail and must never be projected
/// into the form merely because an endpoint returned an error status.
public enum AgentVerificationFailureText {
    public static func httpStatus(_ status: Int) -> String {
        switch status {
        case 401:
            return "Agent verification failed (HTTP 401): the capability was rejected."
        case 403:
            return "Agent verification failed (HTTP 403): the capability cannot access that agent."
        case 404:
            return "Agent verification failed (HTTP 404): the endpoint or route agent ID was not found."
        case 429:
            return "Agent verification failed (HTTP 429): the endpoint is temporarily rate limited."
        default:
            return "Agent verification failed (HTTP \(status))."
        }
    }
}
