import Foundation

public struct SpeechCandidate: Equatable, Sendable {
    public let completionID: String
    public let text: String
}

public enum ConversationEffect: Equatable, Sendable {
    case refreshBacklog
    case speak(SpeechCandidate)
}

public struct ConversationReducer: Sendable {
    public let bindingID: String
    public private(set) var messages: [ConversationMessage] = []
    public private(set) var streamID: String?
    public private(set) var lastSequence = 0
    public private(set) var activeRunCount = 0
    public private(set) var lastError: String?

    private struct LiveRun: Sendable {
        let id: String
        let firstSequence: Int
        var text: String
        var timestamp: String
        var isError: Bool
        var speechEligible: Bool
        var durableMessageID: String?
        var completed: Bool
    }

    private var liveRuns: [String: LiveRun] = [:]
    private var spokenCompletionIDs = Set<String>()

    public init(bindingID: String) {
        self.bindingID = bindingID
    }

    public mutating func loadBacklog(_ backlog: ConversationBacklog, for bindingID: String) {
        guard bindingID == self.bindingID else { return }
        let durable = backlog.messages.filter { !$0.text.isEmpty }
        messages = messages.filter { $0.id.hasPrefix("live:") || $0.id.hasPrefix("pending:") }
        for message in durable { reconcile(message) }
    }

    @discardableResult
    public mutating func apply(
        _ event: ConversationLiveEvent,
        for bindingID: String
    ) -> [ConversationEffect] {
        guard bindingID == self.bindingID else { return [] }
        var effects: [ConversationEffect] = []

        if let current = streamID, current != event.streamId {
            streamID = event.streamId
            lastSequence = 0
            activeRunCount = 0
            liveRuns.removeAll()
            messages.removeAll { $0.id.hasPrefix("live:") }
            effects.append(.refreshBacklog)
        } else if streamID == nil {
            streamID = event.streamId
        }

        guard event.sequence > lastSequence else { return effects }
        lastSequence = event.sequence

        switch event.kind {
        case .message:
            if let message = event.message { reconcile(message) }
        case .state:
            if let runID = event.runId { ensureRun(runID, event: event) }
            lastError = nil
        case .assistant:
            guard let runID = event.runId else { break }
            var run = liveRuns[runID] ?? LiveRun(
                id: runID,
                firstSequence: event.sequence,
                text: "",
                timestamp: event.timestamp,
                isError: false,
                speechEligible: true,
                durableMessageID: nil,
                completed: false
            )
            if event.replace == false, let delta = event.delta {
                run.text += delta
            } else if let text = event.text {
                run.text = text
            } else if let delta = event.delta {
                run.text += delta
            }
            run.timestamp = event.timestamp
            run.isError = event.isError ?? run.isError
            run.speechEligible = event.speechEligible ?? run.speechEligible
            liveRuns[runID] = run
            upsertLiveMessage(run)
            lastError = nil
            updateActiveRunCount()
        case .error:
            if let runID = event.runId { ensureRun(runID, event: event) }
            lastError = event.text ?? "Run failed"
        case .completion:
            guard let runID = event.runId, var run = liveRuns[runID] else {
                updateActiveRunCount()
                break
            }
            run.completed = true
            liveRuns[runID] = run
            updateActiveRunCount()
            let completionID = event.completionId ?? runID
            let trimmed = run.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, !run.isError, run.speechEligible,
               spokenCompletionIDs.insert(completionID).inserted {
                effects.append(.speak(.init(completionID: completionID, text: run.text)))
            }
        case .reset:
            effects.append(.refreshBacklog)
        case .cursor:
            break
        }
        return effects
    }

    public mutating func appendOptimisticUser(text: String, deliveryID: String, timestamp: String? = nil) {
        let message = ConversationMessage(
            id: "pending:\(deliveryID)",
            timestamp: timestamp ?? ISO8601DateFormatter().string(from: Date()),
            role: .user,
            text: text,
            userName: "you",
            deliveryId: deliveryID
        )
        upsert(message)
    }

    public mutating func markDeliveryUnknown(_ deliveryID: String) {
        guard let index = messages.firstIndex(where: { $0.id == "pending:\(deliveryID)" }) else { return }
        let existing = messages[index]
        messages[index] = ConversationMessage(
            id: existing.id,
            timestamp: existing.timestamp,
            role: existing.role,
            text: existing.text,
            channel: existing.channel,
            userName: existing.userName,
            completionId: existing.completionId,
            deliveryId: existing.deliveryId,
            isError: true,
            speechEligible: false
        )
    }

    public mutating func markDeliveryConfirmed(_ deliveryID: String) {
        guard let index = messages.firstIndex(where: { $0.id == "pending:\(deliveryID)" }) else { return }
        let existing = messages[index]
        messages[index] = ConversationMessage(
            id: existing.id,
            timestamp: existing.timestamp,
            role: existing.role,
            text: existing.text,
            channel: existing.channel,
            userName: existing.userName,
            completionId: existing.completionId,
            deliveryId: existing.deliveryId,
            isError: false,
            speechEligible: false
        )
    }

    private mutating func ensureRun(_ runID: String, event: ConversationLiveEvent) {
        if liveRuns[runID] == nil {
            liveRuns[runID] = LiveRun(
                id: runID,
                firstSequence: event.sequence,
                text: "",
                timestamp: event.timestamp,
                isError: false,
                speechEligible: true,
                durableMessageID: nil,
                completed: false
            )
        }
        updateActiveRunCount()
    }

    private mutating func reconcile(_ durable: ConversationMessage) {
        guard !messages.contains(where: { $0.id == durable.id }) else { return }
        if durable.role == .assistant,
           let runID = liveRuns.values
            .filter({ $0.durableMessageID == nil && !$0.text.isEmpty })
            .sorted(by: { $0.firstSequence < $1.firstSequence })
            .first?.id,
           var run = liveRuns[runID] {
            messages.removeAll { $0.id == "live:\(runID)" }
            let reconciled = ConversationMessage(
                id: durable.id,
                timestamp: durable.timestamp,
                role: durable.role,
                text: durable.text,
                channel: durable.channel,
                userName: durable.userName,
                completionId: runID,
                deliveryId: durable.deliveryId,
                isError: durable.isError || run.isError,
                speechEligible: durable.speechEligible && run.speechEligible && !run.isError
            )
            run.durableMessageID = durable.id
            liveRuns[runID] = run
            upsert(reconciled)
            return
        }
        if durable.role == .user, let deliveryID = durable.deliveryId {
            messages.removeAll { $0.id == "pending:\(deliveryID)" }
        }
        upsert(durable)
    }

    private mutating func upsertLiveMessage(_ run: LiveRun) {
        guard run.durableMessageID == nil, !run.text.isEmpty else { return }
        upsert(ConversationMessage(
            id: "live:\(run.id)",
            timestamp: run.timestamp,
            role: .assistant,
            text: run.text,
            completionId: run.id,
            isError: run.isError,
            speechEligible: run.speechEligible && !run.isError
        ))
    }

    private mutating func upsert(_ message: ConversationMessage) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
        } else {
            messages.append(message)
        }
        messages.sort(by: Self.messageOrder)
    }

    private mutating func updateActiveRunCount() {
        activeRunCount = liveRuns.values.filter { !$0.completed }.count
    }

    private static func messageOrder(_ left: ConversationMessage, _ right: ConversationMessage) -> Bool {
        if left.timestamp == right.timestamp { return left.id < right.id }
        return left.timestamp < right.timestamp
    }
}
