import Foundation

/// Mirrors troublemaker/ui/src/console-api.ts so we decode the exact JSON the
/// web UI consumes. Snake_case is converted via `.convertFromSnakeCase`.

public struct Agent: Sendable, Codable, Identifiable, Equatable, Hashable {
    public let id: String
    public let name: String
    public let status: String?
}

public struct AgentListResponse: Sendable, Codable {
    public let agents: [Agent]
}

public struct WorkspaceStatus: Sendable, Codable, Equatable {
    public let agentId: String
    public let mode: String                // "standalone" | "hosted"
    public let runtime: String?
    public let workspaceReady: Bool?
    public let displayMode: String         // "terminal" | "desktop"
    public let agentName: String
    public let capabilities: [String: Bool]?
}

public struct FileNode: Sendable, Codable, Equatable {
    public let name: String
    public let path: String
    public let type: String                // "file" | "directory"
    public let size: Int?
    public let modified: String?
}

public struct FileListResponse: Sendable, Codable {
    public let files: [FileNode]?
}

public struct AwarenessBacklog: Sendable, Codable, Equatable {
    public let lines: [String]
    public let total: Int
    public let offset: Int
}

public struct UploadResponse: Sendable, Codable {
    public let uploaded: [String]?
}

/// A single Server-Sent Event chunk after parsing.
public struct SSEEvent: Sendable, Equatable {
    public let event: String?
    public let data: String
    public let id: String?
}
