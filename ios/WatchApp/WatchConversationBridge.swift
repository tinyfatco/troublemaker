@preconcurrency import WatchConnectivity
import Foundation
import Observation

@MainActor
@Observable
final class WatchConversationBridge: NSObject, WCSessionDelegate {
    private(set) var snapshot: WatchConversationSnapshot?
    private(set) var connectionNote: String?
    private var session: WCSession?

    func start() {
        guard WCSession.isSupported() else {
            connectionNote = "Open Computer on iPhone"
            return
        }
        let session = WCSession.default
        self.session = session
        session.delegate = self
        session.activate()
        consume(session.receivedApplicationContext)
    }

    func sendPrompt(_ rawText: String) {
        guard let bindingID = snapshot?.bindingID else {
            connectionNote = "Select an agent on iPhone"
            return
        }
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        send(.init(bindingID: bindingID, kind: .prompt, text: text))
    }

    func stopAgent() {
        guard let bindingID = snapshot?.bindingID else { return }
        send(.init(bindingID: bindingID, kind: .stop))
    }

    private func send(_ command: WatchCommand) {
        guard let session, let data = try? JSONEncoder().encode(command) else { return }
        let payload: [String: Any] = ["command": data]
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil) { [weak self] _ in
                session.transferUserInfo(payload)
                Task { @MainActor in self?.connectionNote = "Queued for iPhone" }
            }
        } else {
            session.transferUserInfo(payload)
            connectionNote = "Queued for iPhone"
        }
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor [weak self] in
            if let error { self?.connectionNote = error.localizedDescription }
            else {
                self?.connectionNote = activationState == .activated ? nil : "Open Computer on iPhone"
                self?.consume(session.receivedApplicationContext)
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor [weak self] in self?.consume(applicationContext) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor [weak self] in self?.consume(message) }
    }

    private func consume(_ payload: [String: Any]) {
        guard let data = payload["snapshot"] as? Data,
              let decoded = try? JSONDecoder().decode(WatchConversationSnapshot.self, from: data) else { return }
        snapshot = decoded
        connectionNote = nil
    }
}
