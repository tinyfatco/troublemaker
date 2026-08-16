@preconcurrency import WatchConnectivity
import Foundation

@MainActor
final class PhoneWatchBridge: NSObject, WCSessionDelegate {
    var onCommand: ((WatchCommand) -> Void)?
    private var session: WCSession?
    private var latestSnapshot: WatchConversationSnapshot?

    func start() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        self.session = session
        session.delegate = self
        session.activate()
    }

    func stop() {
        onCommand = nil
    }

    func publish(_ snapshot: WatchConversationSnapshot) {
        latestSnapshot = snapshot
        guard let session, session.activationState == .activated,
              let data = try? JSONEncoder().encode(snapshot) else { return }
        try? session.updateApplicationContext(["snapshot": data])
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated else { return }
        Task { @MainActor [weak self] in
            guard let self, let snapshot = self.latestSnapshot else { return }
            self.publish(snapshot)
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        receive(message)
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        receive(userInfo)
    }

    nonisolated private func receive(_ payload: [String: Any]) {
        guard let data = payload["command"] as? Data,
              let command = try? JSONDecoder().decode(WatchCommand.self, from: data) else { return }
        Task { @MainActor [weak self] in self?.onCommand?(command) }
    }
}
