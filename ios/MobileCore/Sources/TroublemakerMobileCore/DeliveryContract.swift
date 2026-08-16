import Foundation

public enum DeliveryState: String, Codable, Equatable, Sendable {
    case prepared
    case sending
    case accepted
    case completed
    case failedBeforeSend
    case unknown
    case canceled
}

public enum DeliveryReceiptState: String, Codable, Equatable, Sendable {
    case accepted
    case completed
}

public struct DeliveryReceipt: Codable, Equatable, Sendable {
    public let deliveryId: String
    public let state: DeliveryReceiptState
    public let claimedAt: String?
    public let completedAt: String?

    public init(
        deliveryId: String,
        state: DeliveryReceiptState,
        claimedAt: String? = nil,
        completedAt: String? = nil
    ) {
        self.deliveryId = deliveryId
        self.state = state
        self.claimedAt = claimedAt
        self.completedAt = completedAt
    }
}

public struct DeliveryReceiptBatch: Codable, Equatable, Sendable {
    public let receipts: [DeliveryReceipt]

    public init(receipts: [DeliveryReceipt]) {
        self.receipts = receipts
    }
}

public struct DeliveryAttempt: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let bindingID: String
    public let exactText: String
    public let createdAt: String
    public private(set) var state: DeliveryState
    public private(set) var requestStarted: Bool

    public init(
        id: String = UUID().uuidString,
        bindingID: String,
        exactText: String,
        createdAt: String = ISO8601DateFormatter().string(from: Date())
    ) {
        self.id = id
        self.bindingID = bindingID
        self.exactText = exactText
        self.createdAt = createdAt
        self.state = .prepared
        self.requestStarted = false
    }

    public mutating func beginRequest() {
        guard state == .prepared || state == .failedBeforeSend else { return }
        requestStarted = true
        state = .sending
    }

    public mutating func accept() {
        guard state != .completed else { return }
        requestStarted = true
        state = .accepted
    }

    public mutating func complete() {
        requestStarted = true
        state = .completed
    }

    public mutating func failTransport() {
        switch state {
        case .prepared, .failedBeforeSend:
            state = .failedBeforeSend
        case .sending:
            state = .unknown
        case .accepted, .completed, .canceled, .unknown:
            break
        }
    }

    public mutating func reconcile(_ receipt: DeliveryReceipt) {
        guard receipt.deliveryId == id else { return }
        switch receipt.state {
        case .accepted:
            if state != .completed { accept() }
        case .completed: complete()
        }
    }

    public var mayAutomaticallyResend: Bool {
        false
    }
}

public struct PendingDeliveryLedger: Codable, Equatable, Sendable {
    public private(set) var attempts: [DeliveryAttempt]
    private let limit: Int

    public init(attempts: [DeliveryAttempt] = [], limit: Int = 128) {
        self.limit = max(1, limit)
        self.attempts = Array(attempts.suffix(max(1, limit)))
    }

    public mutating func upsert(_ attempt: DeliveryAttempt) {
        attempts.removeAll { $0.id == attempt.id }
        attempts.append(attempt)
        if attempts.count > limit { attempts.removeFirst(attempts.count - limit) }
    }

    public mutating func remove(deliveryID: String) {
        attempts.removeAll { $0.id == deliveryID }
    }

    public mutating func reconcile(_ receipts: [DeliveryReceipt]) {
        let byID = Dictionary(uniqueKeysWithValues: receipts.map { ($0.deliveryId, $0) })
        for index in attempts.indices {
            guard let receipt = byID[attempts[index].id] else { continue }
            attempts[index].reconcile(receipt)
        }
    }

    public func attempts(for bindingID: String) -> [DeliveryAttempt] {
        attempts.filter { $0.bindingID == bindingID }
    }
}

public actor SpeechIdentityLedger {
    private var spoken: [String]
    private let limit: Int

    public init(spoken: [String] = [], limit: Int = 256) {
        self.spoken = Array(spoken.suffix(max(1, limit)))
        self.limit = max(1, limit)
    }

    public func claim(_ completionID: String) -> Bool {
        guard !completionID.isEmpty, !spoken.contains(completionID) else { return false }
        spoken.append(completionID)
        if spoken.count > limit { spoken.removeFirst(spoken.count - limit) }
        return true
    }

    public func snapshot() -> [String] { spoken }
}
