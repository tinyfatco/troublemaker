import Foundation

public enum ConversationRole: String, Codable, Sendable {
    case user
    case assistant
}

public struct ConversationMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let timestamp: String
    public let role: ConversationRole
    public let text: String
    public let channel: String?
    public let userName: String?
    public let completionId: String?
    public let deliveryId: String?
    public let isError: Bool
    public let speechEligible: Bool

    public init(
        id: String,
        timestamp: String,
        role: ConversationRole,
        text: String,
        channel: String? = nil,
        userName: String? = nil,
        completionId: String? = nil,
        deliveryId: String? = nil,
        isError: Bool = false,
        speechEligible: Bool = false
    ) {
        self.id = id
        self.timestamp = timestamp
        self.role = role
        self.text = text
        self.channel = channel
        self.userName = userName
        self.completionId = completionId
        self.deliveryId = deliveryId
        self.isError = isError
        self.speechEligible = speechEligible
    }
}

public struct ConversationBacklog: Codable, Equatable, Sendable {
    public let messages: [ConversationMessage]
    public let total: Int
    public let offset: Int
}

public enum ConversationLiveKind: String, Codable, Sendable {
    case message
    case state
    case assistant
    case error
    case completion
    case reset
    case cursor
}

public struct ConversationLiveEvent: Codable, Equatable, Sendable {
    public let sequence: Int
    public let streamId: String
    public let id: String
    public let timestamp: String
    public let kind: ConversationLiveKind
    public let message: ConversationMessage?
    public let runId: String?
    public let state: String?
    public let statusText: String?
    public let completionId: String?
    public let text: String?
    public let delta: String?
    public let replace: Bool?
    public let isFinal: Bool?
    public let isError: Bool?
    public let speechEligible: Bool?
    public let reason: String?

    public init(
        sequence: Int,
        streamId: String,
        id: String,
        timestamp: String,
        kind: ConversationLiveKind,
        message: ConversationMessage? = nil,
        runId: String? = nil,
        state: String? = nil,
        statusText: String? = nil,
        completionId: String? = nil,
        text: String? = nil,
        delta: String? = nil,
        replace: Bool? = nil,
        isFinal: Bool? = nil,
        isError: Bool? = nil,
        speechEligible: Bool? = nil,
        reason: String? = nil
    ) {
        self.sequence = sequence
        self.streamId = streamId
        self.id = id
        self.timestamp = timestamp
        self.kind = kind
        self.message = message
        self.runId = runId
        self.state = state
        self.statusText = statusText
        self.completionId = completionId
        self.text = text
        self.delta = delta
        self.replace = replace
        self.isFinal = isFinal
        self.isError = isError
        self.speechEligible = speechEligible
        self.reason = reason
    }
}

public enum TurnEventKind: String, Codable, Sendable {
    case delivery
    case state
    case assistantDelta = "assistant_delta"
    case assistantText = "assistant_text"
    case error
    case completion
    case heartbeat
}

public struct SSEPayload: Equatable, Sendable {
    public let data: String
    public let id: String?
}

public struct SSELineParser: Sendable {
    private var eventID: String?
    private var dataLines: [String] = []

    public init() {}

    public mutating func consume(_ line: String) -> [SSEPayload] {
        if line.isEmpty {
            return emitPending()
        }
        if line.hasPrefix(":") { return [] }
        guard let colon = line.firstIndex(of: ":") else { return [] }
        let field = String(line[..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.first == " " { value.removeFirst() }
        if field == "id" {
            eventID = value
            return []
        }
        guard field == "data" else { return [] }

        // Troublemaker emits each JSON envelope on one data line. Yield it as
        // soon as CFNetwork exposes that line; some live responses do not
        // promptly surface the following blank SSE delimiter.
        if value == "[DONE]" || value.hasPrefix("{") {
            dataLines.removeAll(keepingCapacity: true)
            return [emit(value)]
        }
        dataLines.append(value)
        return []
    }

    public mutating func finish() -> [SSEPayload] {
        emitPending()
    }

    private mutating func emitPending() -> [SSEPayload] {
        guard !dataLines.isEmpty else {
            eventID = nil
            return []
        }
        let value = dataLines.joined(separator: "\n")
        dataLines.removeAll(keepingCapacity: true)
        return [emit(value)]
    }

    private mutating func emit(_ data: String) -> SSEPayload {
        defer { eventID = nil }
        return SSEPayload(data: data, id: eventID)
    }
}

public struct TurnEvent: Codable, Equatable, Sendable {
    public let type: TurnEventKind
    public let disposition: String?
    public let deliveryId: String?
    public let state: String?
    public let message: String?
    public let delta: String?
    public let text: String?
}

public struct OutgoingTurn: Codable, Equatable, Sendable {
    public let message: String
    public let channelId: String
    public let source: String
    public let sourceEventType: String
    public let deliveryId: String

    public init(message: String, deliveryId: String, channelId: String = "ios") {
        self.message = message
        self.channelId = channelId
        self.source = "ios"
        self.sourceEventType = "ios_conversation"
        self.deliveryId = deliveryId
    }
}

public extension JSONDecoder {
    static func troublemakerMobile() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}
