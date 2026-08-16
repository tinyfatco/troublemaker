import Foundation
import Observation

struct DeliveryAttemptStore {
    let fileURL: URL

    init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
            return
        }
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        self.fileURL = root
            .appendingPathComponent("Computer", isDirectory: true)
            .appendingPathComponent("pending-deliveries.json", isDirectory: false)
    }

    func load() throws -> PendingDeliveryLedger {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return PendingDeliveryLedger() }
        return try JSONDecoder().decode(PendingDeliveryLedger.self, from: Data(contentsOf: fileURL))
    }

    func save(_ ledger: PendingDeliveryLedger) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(ledger)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

@MainActor
@Observable
final class ConversationController {
    let binding: AgentBinding
    private(set) var messages: [ConversationMessage] = []
    private(set) var statusText: String?
    private(set) var deliveryNotice: String?
    private(set) var isListening = false
    private(set) var isSpeaking = false
    private(set) var activeRunCount = 0
    private(set) var lastError: String?
    private(set) var transcriptPreview = ""
    var input = ""

    var presenceState: ComputerPresenceState {
        PresenceInputs(
            isListening: isListening,
            activeRunCount: activeRunCount,
            isSpeaking: isSpeaking,
            errorMessage: lastError
        ).state
    }

    private let client: MobileAgentClient
    private var reducer: ConversationReducer
    private let speech = SerializedSpeechCoordinator()
    private let pushToTalk = PushToTalkController()
    private let watchBridge = PhoneWatchBridge()
    private var watchCommands = WatchCommandLedger()
    private var liveTask: Task<Void, Never>?
    private var sendTasks: [String: Task<Void, Never>] = [:]
    private var deliveries: [String: DeliveryAttempt] = [:]
    private var deliveryTransportErrors: [String: String] = [:]
    private var durableDeliveryIDs = Set<String>()
    private var pendingLedger = PendingDeliveryLedger()
    private let deliveryStore: DeliveryAttemptStore

    init(
        binding: AgentBinding,
        client: MobileAgentClient,
        deliveryStore: DeliveryAttemptStore = DeliveryAttemptStore()
    ) {
        self.binding = binding
        self.client = client
        self.deliveryStore = deliveryStore
        self.reducer = ConversationReducer(bindingID: binding.id)
        speech.onSpeakingChanged = { [weak self] speaking in
            self?.isSpeaking = speaking
            self?.publishWatchSnapshot()
        }
        watchBridge.onCommand = { [weak self] command in
            self?.handleWatchCommand(command)
        }
    }

    func start() {
        watchBridge.start()
        restorePendingDeliveries()
        Task {
            await refreshBacklog()
            await reconcilePendingDeliveries()
        }
        liveTask?.cancel()
        liveTask = Task { [weak self] in await self?.runLiveLoop() }
        publishWatchSnapshot()
    }

    func stop() {
        liveTask?.cancel()
        liveTask = nil
        for task in sendTasks.values { task.cancel() }
        sendTasks.removeAll()
        pushToTalk.cancel()
        speech.stop()
        watchBridge.stop()
    }

    func sendCurrentInput() {
        let text = input
        input = ""
        send(text)
    }

    func send(_ rawText: String) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        var attempt = DeliveryAttempt(bindingID: binding.id, exactText: text)
        guard persist(attempt) else {
            deliveryNotice = "Couldn’t save this delivery safely"
            return
        }
        reducer.appendOptimisticUser(text: text, deliveryID: attempt.id, timestamp: attempt.createdAt)
        syncReducerState()
        statusText = activeRunCount > 0 ? "Steering…" : "Sending…"
        deliveryNotice = nil
        lastError = nil

        let task = Task { [weak self] in
            guard let self else { return }
            attempt.beginRequest()
            guard persist(attempt) else {
                deliveryNotice = "Not sent — delivery tracking is unavailable"
                statusText = nil
                reducer.markDeliveryUnknown(attempt.id)
                syncReducerState()
                sendTasks[attempt.id] = nil
                return
            }
            do {
                let stream = try await client.send(attempt)
                var receivedDisposition = false
                for try await event in stream {
                    guard !Task.isCancelled else { return }
                    switch event.type {
                    case .delivery:
                        if event.disposition == "accepted" || event.disposition == "duplicate" {
                            attempt.accept()
                            receivedDisposition = true
                            deliveryNotice = event.disposition == "duplicate" ? "Already delivered" : nil
                        } else if event.disposition == "completed" {
                            attempt.complete()
                            receivedDisposition = true
                        }
                        _ = persist(attempt)
                        reducer.markDeliveryConfirmed(attempt.id)
                    case .state:
                        statusText = event.message ?? "Thinking…"
                    case .error:
                        lastError = event.message ?? "Run failed"
                        statusText = lastError
                    case .assistantDelta, .assistantText, .completion, .heartbeat:
                        // The ordered live feed is authoritative for rendering and speech.
                        break
                    }
                }
                if !receivedDisposition && attempt.state == .sending {
                    attempt.failTransport()
                    reducer.markDeliveryUnknown(attempt.id)
                    deliveryNotice = "Delivery unknown — not resent"
                }
            } catch is CancellationError {
                return
            } catch {
                attempt.failTransport()
                if attempt.state == .unknown {
                    reducer.markDeliveryUnknown(attempt.id)
                    deliveryNotice = "Delivery unknown — not resent"
                    let message = error.localizedDescription
                    deliveryTransportErrors[attempt.id] = message
                    lastError = message
                } else {
                    reducer.markDeliveryConfirmed(attempt.id)
                    deliveryNotice = nil
                }
            }
            _ = persist(attempt)
            sendTasks[attempt.id] = nil
            syncReducerState()
            await reconcilePendingDeliveries()
        }
        sendTasks[attempt.id] = task
    }

    func stopAgent() {
        speech.stop()
        Task {
            do {
                try await client.stop()
                statusText = "Stopping…"
            } catch is CancellationError {
                return
            } catch {
                lastError = error.localizedDescription
            }
            publishWatchSnapshot()
        }
    }

    func beginPushToTalk() {
        guard !isListening else { return }
        speech.stop()
        lastError = nil
        transcriptPreview = ""
        isListening = true
        statusText = "Listening…"
        publishWatchSnapshot()
        let key = SecureCredentialStore.load(account: MobileCredentialAccount.deepgram) ?? ""
        Task {
            do {
                try await pushToTalk.begin(
                    apiKey: key,
                    onPartial: { [weak self] partial in
                        self?.transcriptPreview = partial
                    },
                    onError: { [weak self] message in
                        guard let self else { return }
                        self.lastError = message
                        self.statusText = message
                        self.publishWatchSnapshot()
                    }
                )
            } catch is CancellationError {
                isListening = false
                if activeRunCount == 0 { statusText = nil }
                publishWatchSnapshot()
            } catch {
                isListening = false
                lastError = error.localizedDescription
                statusText = lastError
                publishWatchSnapshot()
            }
        }
    }

    func endPushToTalk() {
        guard isListening else { return }
        statusText = "Finishing…"
        Task {
            let text = await pushToTalk.finish()
            isListening = false
            transcriptPreview = ""
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                send(text)
            } else if lastError == nil {
                statusText = activeRunCount > 0 ? "Thinking…" : nil
            }
            publishWatchSnapshot()
        }
    }

    private func refreshBacklog() async {
        do {
            let backlog = try await client.backlog()
            reducer.loadBacklog(backlog, for: binding.id)
            reconcileDurableDeliveries(backlog.messages)
            syncReducerState()
        } catch is CancellationError {
            return
        } catch {
            lastError = error.localizedDescription
            statusText = "History unavailable"
            publishWatchSnapshot()
        }
    }

    private func runLiveLoop() async {
        var reconnectAttempt = 0
        while !Task.isCancelled {
            do {
                let stream = try await client.live(after: reducer.lastSequence)
                reconnectAttempt = 0
                for try await event in stream {
                    if Task.isCancelled { return }
                    let effects = reducer.apply(event, for: binding.id)
                    apply(effects)
                    if let message = event.message { reconcileDurableDeliveries([message]) }
                    if event.kind == .cursor {
                        if statusText == "Reconnecting…" {
                            statusText = activeRunCount > 0 ? "Thinking…" : nil
                            lastError = nil
                        }
                        await reconcilePendingDeliveries()
                    }
                    if event.kind == .state {
                        lastError = nil
                        statusText = event.statusText ?? "Thinking…"
                    }
                    if event.kind == .assistant { lastError = nil }
                    if event.kind == .error {
                        lastError = event.text ?? "Run failed"
                        statusText = lastError
                    }
                    if event.kind == .completion, reducer.activeRunCount == 0, !isSpeaking {
                        lastError = nil
                        statusText = nil
                    }
                    syncReducerState()
                }
            } catch is CancellationError {
                return
            } catch {
                reconnectAttempt += 1
                statusText = "Reconnecting…"
                if reconnectAttempt > 1 { lastError = error.localizedDescription }
                publishWatchSnapshot()
                try? await Task.sleep(nanoseconds: ReconnectDelay.nanoseconds(for: reconnectAttempt - 1))
            }
        }
    }

    private func apply(_ effects: [ConversationEffect]) {
        for effect in effects {
            switch effect {
            case .refreshBacklog:
                Task { await refreshBacklog() }
            case .speak(let candidate):
                speech.enqueue(candidate)
            }
        }
    }

    private func syncReducerState() {
        messages = reducer.messages
        activeRunCount = reducer.activeRunCount
        publishWatchSnapshot()
    }

    private func restorePendingDeliveries() {
        do {
            pendingLedger = try deliveryStore.load()
            var changed = false
            for storedAttempt in pendingLedger.attempts(for: binding.id) {
                var attempt = storedAttempt
                if attempt.state == .sending {
                    attempt.failTransport()
                    pendingLedger.upsert(attempt)
                    changed = true
                }
                deliveries[attempt.id] = attempt
                reducer.appendOptimisticUser(
                    text: attempt.exactText,
                    deliveryID: attempt.id,
                    timestamp: attempt.createdAt
                )
                if attempt.state == .unknown || attempt.state == .sending || attempt.state == .prepared || attempt.state == .failedBeforeSend {
                    reducer.markDeliveryUnknown(attempt.id)
                } else if attempt.state == .accepted || attempt.state == .completed {
                    reducer.markDeliveryConfirmed(attempt.id)
                }
            }
            if deliveries.values.contains(where: { $0.state == .unknown }) {
                deliveryNotice = "Checking previous delivery…"
            } else if deliveries.values.contains(where: { $0.state == .prepared || $0.state == .failedBeforeSend }) {
                deliveryNotice = "Previous message was not sent"
            }
            if changed { try deliveryStore.save(pendingLedger) }
            syncReducerState()
        } catch {
            deliveryNotice = "Pending delivery history is unavailable"
        }
    }

    @discardableResult
    private func persist(_ attempt: DeliveryAttempt) -> Bool {
        if durableDeliveryIDs.contains(attempt.id) {
            deliveries[attempt.id] = nil
            pendingLedger.remove(deliveryID: attempt.id)
            do {
                try deliveryStore.save(pendingLedger)
                return true
            } catch {
                return false
            }
        }
        var updated = pendingLedger
        updated.upsert(attempt)
        do {
            try deliveryStore.save(updated)
            pendingLedger = updated
            deliveries[attempt.id] = attempt
            return true
        } catch {
            return false
        }
    }

    private func reconcilePendingDeliveries() async {
        let attempts = deliveries.values.filter { $0.bindingID == binding.id }
        guard !attempts.isEmpty else { return }
        do {
            let ids = attempts.map(\.id).sorted()
            var receipts: [DeliveryReceipt] = []
            for start in stride(from: 0, to: ids.count, by: 50) {
                receipts += try await client.deliveryReceipts(for: Array(ids[start..<min(start + 50, ids.count)]))
            }
            guard !receipts.isEmpty else {
                if attempts.contains(where: { $0.state == .unknown }) {
                    deliveryNotice = "Delivery unknown — not resent"
                    syncReducerState()
                }
                return
            }
            let byID = Dictionary(uniqueKeysWithValues: receipts.map { ($0.deliveryId, $0) })
            for var attempt in attempts {
                guard let receipt = byID[attempt.id] else { continue }
                attempt.reconcile(receipt)
                _ = persist(attempt)
                reducer.markDeliveryConfirmed(attempt.id)
                clearDeliveryTransportError(attempt.id)
            }
            deliveryNotice = deliveries.values.contains(where: {
                $0.bindingID == binding.id && $0.state == .unknown
            }) ? "Delivery unknown — not resent" : nil
            if deliveryNotice == nil, statusText == "Reconnecting…" { statusText = nil }
            syncReducerState()
        } catch {
            // An unavailable receipt lookup leaves the conservative unknown
            // state intact. It never authorizes a resend.
        }
    }

    private func reconcileDurableDeliveries(_ messages: [ConversationMessage]) {
        let deliveryIDs = Set(messages.compactMap { message in
            message.role == .user ? message.deliveryId : nil
        })
        guard !deliveryIDs.isEmpty else { return }
        for deliveryID in deliveryIDs {
            durableDeliveryIDs.insert(deliveryID)
            deliveries[deliveryID] = nil
            pendingLedger.remove(deliveryID: deliveryID)
            clearDeliveryTransportError(deliveryID)
        }
        try? deliveryStore.save(pendingLedger)
        if !deliveries.values.contains(where: {
            $0.bindingID == binding.id && $0.state == .unknown
        }) {
            deliveryNotice = nil
        }
    }

    private func clearDeliveryTransportError(_ deliveryID: String) {
        guard let message = deliveryTransportErrors.removeValue(forKey: deliveryID) else { return }
        if lastError == message { lastError = nil }
    }

    private func handleWatchCommand(_ command: WatchCommand) {
        guard watchCommands.claim(command, selectedBindingID: binding.id) else { return }
        switch command.kind {
        case .prompt:
            if let text = command.text { send(text) }
        case .stop:
            stopAgent()
        }
    }

    private func publishWatchSnapshot() {
        watchBridge.publish(.init(
            bindingID: binding.id,
            agentName: binding.displayName,
            state: presenceState,
            statusText: statusText,
            messages: messages
        ))
    }
}
