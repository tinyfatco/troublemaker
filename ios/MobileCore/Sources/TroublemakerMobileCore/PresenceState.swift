import Foundation

public enum ComputerPresenceState: String, Codable, CaseIterable, Sendable {
    case idle
    case listening
    case thinking
    case speaking
    case error
}

public struct PresenceInputs: Equatable, Sendable {
    public var isListening: Bool
    public var activeRunCount: Int
    public var isSpeaking: Bool
    public var errorMessage: String?

    public init(
        isListening: Bool = false,
        activeRunCount: Int = 0,
        isSpeaking: Bool = false,
        errorMessage: String? = nil
    ) {
        self.isListening = isListening
        self.activeRunCount = activeRunCount
        self.isSpeaking = isSpeaking
        self.errorMessage = errorMessage
    }

    public var state: ComputerPresenceState {
        if isListening { return .listening }
        if isSpeaking { return .speaking }
        if activeRunCount > 0 { return .thinking }
        if errorMessage?.isEmpty == false { return .error }
        return .idle
    }
}

public struct WatchConversationSnapshot: Codable, Equatable, Sendable {
    public let bindingID: String
    public let agentName: String
    public let state: ComputerPresenceState
    public let statusText: String?
    public let messages: [ConversationMessage]
    public let generatedAt: Date

    public init(
        bindingID: String,
        agentName: String,
        state: ComputerPresenceState,
        statusText: String?,
        messages: [ConversationMessage],
        generatedAt: Date = Date()
    ) {
        self.bindingID = bindingID
        self.agentName = agentName
        self.state = state
        self.statusText = statusText
        self.messages = Array(messages.suffix(20))
        self.generatedAt = generatedAt
    }
}

public enum WatchCommandKind: String, Codable, Sendable {
    case prompt
    case stop
}

public struct WatchCommand: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let bindingID: String
    public let kind: WatchCommandKind
    public let text: String?

    public init(
        id: String = UUID().uuidString,
        bindingID: String,
        kind: WatchCommandKind,
        text: String? = nil
    ) {
        self.id = id
        self.bindingID = bindingID
        self.kind = kind
        self.text = text
    }

    public func isAuthorized(for selectedBindingID: String) -> Bool {
        bindingID == selectedBindingID && (kind == .stop || text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
    }
}

public struct WatchCommandLedger: Sendable {
    private var handled: [String]
    private let limit: Int

    public init(limit: Int = 256) {
        self.handled = []
        self.limit = max(1, limit)
    }

    public mutating func claim(_ command: WatchCommand, selectedBindingID: String) -> Bool {
        guard command.isAuthorized(for: selectedBindingID) else { return false }
        guard !handled.contains(command.id) else { return false }
        handled.append(command.id)
        if handled.count > limit { handled.removeFirst(handled.count - limit) }
        return true
    }
}
