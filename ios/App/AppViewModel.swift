import Foundation
import Observation

@MainActor
@Observable
final class AppViewModel {
    enum Phase: Equatable {
        case loading
        case choosing
        case conversation
    }

    private(set) var phase: Phase = .loading
    private(set) var bindings: [AgentBinding] = []
    private(set) var selectedBinding: AgentBinding?
    private(set) var conversation: ConversationController?
    var errorMessage: String?
    private(set) var enrollmentErrorMessage: String?
    var isEnrolling = false

    private let catalog = AgentCatalogStore()

    func bootstrap() async {
        if let fixture = Self.fixtureBinding() {
            bindings = [fixture]
            await select(fixture, persist: false)
            return
        }

        bindings = catalog.loadBindings()
        if let selectedID = catalog.selectedBindingID(),
           let binding = bindings.first(where: { $0.id == selectedID }) {
            await select(binding, persist: false)
        } else {
            phase = .choosing
        }
    }

    func enroll(_ enrollment: AgentEnrollment) async {
        guard !isEnrolling else { return }
        enrollmentErrorMessage = nil
        isEnrolling = true
        defer { isEnrolling = false }
        do {
            let provisional = try AgentBinding(
                displayName: enrollment.displayName,
                baseURL: enrollment.baseURL,
                routeAgentID: enrollment.routeAgentID,
                subjectAgentID: enrollment.routeAgentID == "current" ? "pending" : enrollment.routeAgentID
            )
            let probe = MobileAgentClient(binding: provisional, token: enrollment.accessToken)
            let status = try await probe.probeStatus()
            guard status.workspaceReady else { throw EnrollmentError.workspaceNotReady }
            let binding = try AgentBinding(
                id: provisional.id,
                displayName: status.agentName.isEmpty ? enrollment.displayName : status.agentName,
                baseURL: enrollment.baseURL,
                routeAgentID: enrollment.routeAgentID,
                subjectAgentID: status.agentId,
                credentialAccount: provisional.credentialAccount
            )
            try SecureCredentialStore.save(enrollment.accessToken, account: binding.credentialAccount)
            if !enrollment.deepgramAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try SecureCredentialStore.save(enrollment.deepgramAPIKey, account: MobileCredentialAccount.deepgram)
            }
            bindings.removeAll { $0.id == binding.id || ($0.baseURL == binding.baseURL && $0.subjectAgentID == binding.subjectAgentID) }
            bindings.append(binding)
            bindings.sort { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            try catalog.saveBindings(bindings)
            await select(binding)
        } catch {
            enrollmentErrorMessage = Self.safeEnrollmentFailure(error)
        }
    }

    func clearEnrollmentFeedback() {
        guard !isEnrolling else { return }
        enrollmentErrorMessage = nil
    }

    func select(_ binding: AgentBinding, persist: Bool = true) async {
        conversation?.stop()
        let token = SecureCredentialStore.load(account: binding.credentialAccount)
            ?? ProcessInfo.processInfo.environment["COMPUTER_MOBILE_FIXTURE_TOKEN"]
            ?? ""
        let client = MobileAgentClient(binding: binding, token: token)
        do {
            _ = try await client.status()
            let controller = ConversationController(binding: binding, client: client)
            self.selectedBinding = binding
            self.conversation = controller
            self.phase = .conversation
            if persist { catalog.select(binding.id) }
            controller.start()
        } catch {
            errorMessage = error.localizedDescription
            selectedBinding = nil
            conversation = nil
            phase = .choosing
        }
    }

    func showChooser() {
        conversation?.stop()
        conversation = nil
        selectedBinding = nil
        phase = .choosing
    }

    func remove(_ binding: AgentBinding) {
        if selectedBinding?.id == binding.id { showChooser() }
        bindings.removeAll { $0.id == binding.id }
        SecureCredentialStore.remove(account: binding.credentialAccount)
        try? catalog.saveBindings(bindings)
        if catalog.selectedBindingID() == binding.id { catalog.select(nil) }
    }

    private static func fixtureBinding() -> AgentBinding? {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        guard let rawURL = environment["COMPUTER_MOBILE_FIXTURE_BASE_URL"],
              let url = URL(string: rawURL) else { return nil }
        return try? AgentBinding(
            id: "fixture-binding",
            displayName: environment["COMPUTER_MOBILE_FIXTURE_NAME"] ?? "Fixture Agent",
            baseURL: url,
            routeAgentID: environment["COMPUTER_MOBILE_FIXTURE_ROUTE_ID"] ?? "current",
            subjectAgentID: environment["COMPUTER_MOBILE_FIXTURE_AGENT_ID"] ?? "agent-fixture",
            credentialAccount: "fixture-agent"
        )
        #else
        return nil
        #endif
    }

    private static func safeEnrollmentFailure(_ error: Error) -> String {
        if let mobileError = error as? MobileAPIError {
            return mobileError.localizedDescription
        }
        if let bindingError = error as? AgentBindingError {
            return bindingError.localizedDescription
        }
        if let enrollmentError = error as? EnrollmentError {
            return enrollmentError.localizedDescription
        }
        if let secureStoreError = error as? SecureStoreError {
            return secureStoreError.localizedDescription
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut:
                return "Agent verification timed out."
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .notConnectedToInternet:
                return "Could not reach the agent endpoint."
            default:
                return "Could not verify the agent endpoint."
            }
        }
        if error is DecodingError {
            return "The agent returned an invalid status response."
        }
        return "Agent verification failed."
    }
}

enum EnrollmentError: Error, LocalizedError {
    case workspaceNotReady
    var errorDescription: String? { "The selected agent workspace is not ready." }
}
