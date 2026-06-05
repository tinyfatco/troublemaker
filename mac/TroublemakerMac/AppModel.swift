import AppKit
import Foundation
import Security
import SwiftUI

enum AssistantPhase: String {
	case starting = "Starting"
	case listening = "Listening"
	case thinking = "Thinking"
	case acting = "Acting"
	case speaking = "Speaking"
	case idle = "Ready"
	case error = "Needs attention"

	var color: Color {
		switch self {
		case .starting: return .orange
		case .listening: return .green
		case .thinking: return .blue
		case .acting: return .purple
		case .speaking: return .teal
		case .idle: return .secondary
		case .error: return .red
		}
	}
}

enum AuthPhase: Equatable {
	case loading
	case signedOut
	case signingIn
	case signedIn(tokenSummary: String)

	var isSignedIn: Bool {
		if case .signedIn = self { return true }
		return false
	}

	var label: String {
		switch self {
		case .loading: return "Checking sign-in"
		case .signedOut: return "Signed out"
		case .signingIn: return "Signing in"
		case .signedIn: return "Signed in"
		}
	}
}

struct ChatMessage: Identifiable, Equatable, Codable {
	enum Role: String, Codable {
		case user
		case assistant
		case system
	}

	var id = UUID()
	var role: Role
	var text: String
	var details: [String] = []
	var isStreaming = false
	var createdAt = Date()

	init(
		id: UUID = UUID(),
		role: Role,
		text: String,
		details: [String] = [],
		isStreaming: Bool = false,
		createdAt: Date = Date()
	) {
		self.id = id
		self.role = role
		self.text = text
		self.details = details
		self.isStreaming = isStreaming
		self.createdAt = createdAt
	}
}

struct AssistantActivityItem: Identifiable, Equatable {
	enum Kind: String {
		case input
		case status
		case thinking
		case tool
		case result
		case assistant
		case error
	}

	let id = UUID()
	var kind: Kind
	var title: String
	var detail: String
	var symbol: String
	var createdAt = Date()
}

@MainActor
final class AppModel: ObservableObject {
	@Published var backend = BackendSnapshot()
	@Published var phase: AssistantPhase = .starting
	@Published var authPhase: AuthPhase = .loading
	@Published var authError: String?
	@Published var cloudAgents: [CloudAgent] = []
	@Published var isLoadingCloudAgents = false
	@Published var cloudAwareness: [CloudAwarenessEntry] = []
	@Published var cloudAwarenessStatus = "Not loaded"
	@Published var cloudAwarenessLoaded = false
	@Published var isLoadingCloudAwareness = false
	@Published var cloudAwarenessLoadedAt: Date?
	@Published var localAwarenessHydrated = false
	@Published var localAwarenessHydrationStatus = "Not hydrated"
	@Published var selectedCloudBinding: CloudAgentBinding?
	@Published var profile: TenantRuntimeProfile
	@Published var draft = ""
	@Published var messages: [ChatMessage] = []
	@Published var activity: [AssistantActivityItem] = []
	@Published var logs: [String] = []
	@Published var lastTranscript = ""
	@Published var isSending = false
	@Published var selectedVoiceProvider: VoiceProviderKind = .localTroublemaker
	@Published var selectedRealtimeVoice: RealtimeVoice = .marin
	@Published var voiceState: VoiceRuntimeState = .idle
	@Published var voiceStatus = "Voice idle"
	@Published var voicePartialTranscript = ""
	@Published var selectedAgentID = "unbound-local-desktop"
	@Published var selectedAgentName = "No Agent Selected"
	@Published var cloudAgentID: String?
	@Published var tenantID: String?

	private let projectRoot: URL
	private let oauth: OAuthClient
	private let tokenStore: TokenStore
	private let clientIDStore: ClientIDStore
	private let bindingStore = AgentBindingStore()
	private let voiceSession = MacVoiceSession()
	private static let realtimeVoiceDefaultsKey = "TroublemakerRealtimeVoice"

	private var supervisor: RuntimeSupervisor
	private var client: LocalAgentClient
	private var cloudClient: CloudAgentClient?
	private var clientID: String?
	private var pendingOAuth: PendingOAuthAttempt?
	private var didStart = false
	private var healthTask: Task<Void, Never>?
	private var sendTask: Task<Void, Never>?
	private var voiceAssistantMessageID: UUID?
	private var persistedEventKeys = Set<String>()
	private let localControlToken = AppModel.makeLocalControlToken()

	init(projectRoot: URL? = nil, profile overrideProfile: TenantRuntimeProfile? = nil, oauth: OAuthClient = OAuthClient()) {
		let resolvedRoot = (try? BundlePaths.projectRoot()) ?? projectRoot ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
		let savedBinding = AgentBindingStore().load()
		let resolvedProfile = overrideProfile ?? savedBinding.map { TenantRuntimeProfile.cloudBound($0) } ?? .current()

		self.projectRoot = resolvedRoot
		self.oauth = oauth
		tokenStore = TokenStore(issuer: oauth.issuer)
		clientIDStore = ClientIDStore(issuer: oauth.issuer)
		if let savedVoice = UserDefaults.standard.string(forKey: Self.realtimeVoiceDefaultsKey),
		   let voice = RealtimeVoice(rawValue: savedVoice) {
			selectedRealtimeVoice = voice
		}
		selectedCloudBinding = savedBinding
		profile = resolvedProfile
		supervisor = RuntimeSupervisor(projectRoot: resolvedRoot, profile: resolvedProfile)
		client = LocalAgentClient(port: resolvedProfile.port)

		applyProfileToPublished(resolvedProfile)
		backend.port = resolvedProfile.port
		loadLocalMessagesForCurrentProfile()
		if let savedBinding {
			recordActivity(.status, title: "Agent selected", detail: savedBinding.name, symbol: "person.badge.key")
		} else {
			recordActivity(.status, title: "Local runtime", detail: resolvedProfile.agentName, symbol: "desktopcomputer")
		}
		wireVoiceCallbacks()
	}

	var canUseBoundRuntime: Bool {
		if profile.isCloudBound {
			return authPhase.isSignedIn && selectedCloudBinding != nil
		}
		return true
	}

	var canUseJarvisChat: Bool {
		canUseBoundRuntime
	}

	var canUseVoice: Bool {
		switch selectedVoiceProvider {
		case .localTroublemaker, .openAIRealtime, .deepgram:
			return canUseJarvisChat
		}
	}

	var isVoiceActive: Bool {
		voiceState.isActive
	}

	var latestActivityTitle: String {
		if isVoiceActive {
			return voiceStatus
		}
		return activity.last?.title ?? phase.rawValue
	}

	var latestActivityDetail: String {
		if isVoiceActive {
			if !voicePartialTranscript.isEmpty { return voicePartialTranscript }
			if !lastTranscript.isEmpty { return lastTranscript }
		}
		if !lastTranscript.isEmpty && isSending {
			return lastTranscript
		}
		return activity.last?.detail ?? backend.message
	}

	var latestActivitySymbol: String {
		if isVoiceActive {
			switch voiceState {
			case .speaking: return "speaker.wave.2.fill"
			case .thinking: return "brain"
			case .transcribing, .listening, .connecting: return "mic.fill"
			case .idle, .error: break
			}
		}
		return activity.last?.symbol ?? "sparkles"
	}

	func start() {
		guard !didStart else { return }
		didStart = true
		wireSupervisorCallbacks()
		Task { [weak self] in
			guard let self else { return }
			await self.bootstrapCloudAuth()
			if self.canUseBoundRuntime {
				self.beginBackendMonitoring()
			} else {
				self.backend.state = .stopped
				self.backend.message = "Sign in to use the selected cloud agent."
				self.phase = .idle
			}
		}
	}

	func signInToTinyFat() {
		if case .signingIn = authPhase { return }
		authPhase = .signingIn
		authError = nil
		recordActivity(.status, title: "Signing in", detail: oauth.issuer.host ?? oauth.issuer.absoluteString, symbol: "person.badge.key")

		Task { [weak self] in
			guard let self else { return }
			do {
				let pkce = OAuthClient.PKCE()
				let state = UUID().uuidString
				let resolvedClientID: String
				if let existingClientID = self.clientIDStore.load() {
					resolvedClientID = existingClientID
				} else {
					resolvedClientID = try await self.oauth.registerClient()
					self.clientIDStore.save(resolvedClientID)
				}
				let authURL = self.oauth.authorizeURL(clientID: resolvedClientID, pkce: pkce, state: state)
				self.pendingOAuth = PendingOAuthAttempt(pkce: pkce, state: state, clientID: resolvedClientID)
				guard NSWorkspace.shared.open(authURL) else {
					throw OAuthLaunchError.browserOpenFailed(authURL.absoluteString)
				}
				self.recordActivity(.status, title: "Browser opened", detail: "Complete TinyFat sign-in in Chrome.", symbol: "safari")
			} catch {
				self.authPhase = .signedOut
				self.authError = String(describing: error)
				self.phase = .error
				self.backend.message = "Sign-in failed."
				self.recordActivity(.error, title: "Sign-in failed", detail: String(describing: error), symbol: "exclamationmark.triangle")
			}
		}
	}

	func handleOAuthCallback(_ callback: URL) {
		guard let pendingOAuth else {
			authError = "Received OAuth callback without a pending sign-in."
			recordActivity(.error, title: "OAuth callback ignored", detail: callback.absoluteString, symbol: "exclamationmark.triangle")
			return
		}
		self.pendingOAuth = nil
		Task { [weak self] in
			guard let self else { return }
			do {
				let code = try self.oauth.authorizationCode(from: callback, expectedState: pendingOAuth.state)
				let tokens = try await self.oauth.exchangeCode(code, pkce: pendingOAuth.pkce, clientID: pendingOAuth.clientID)
				try self.tokenStore.save(tokens)
				self.clientIDStore.save(pendingOAuth.clientID)
				self.clientID = pendingOAuth.clientID
				self.cloudClient = CloudAgentClient(baseURL: self.oauth.issuer, clientID: pendingOAuth.clientID, oauth: self.oauth, tokenStore: self.tokenStore)
				self.authPhase = .signedIn(tokenSummary: Self.tokenSummary(tokens.accessToken))
				self.authError = nil
				self.activity = []
				self.messages = []
				self.recordActivity(.status, title: "Signed in", detail: "Loading available agents.", symbol: "checkmark.seal")
				await self.loadCloudAgents()
				if self.selectedCloudBinding != nil {
					await self.loadCloudAwareness()
				}
				if self.canUseBoundRuntime {
					self.beginBackendMonitoring()
				}
			} catch {
				self.authPhase = .signedOut
				self.authError = String(describing: error)
				self.phase = .error
				self.backend.message = "OAuth callback failed."
				self.recordActivity(.error, title: "OAuth failed", detail: String(describing: error), symbol: "exclamationmark.triangle")
			}
		}
	}

	func signOut() {
		stopVoice()
		sendTask?.cancel()
		healthTask?.cancel()
		tokenStore.clear()
		clientIDStore.clear()
		bindingStore.clear()
		cloudClient = nil
		clientID = nil
		cloudAgents = []
		cloudAwareness = []
		cloudAwarenessStatus = "Not loaded"
		cloudAwarenessLoaded = false
		cloudAwarenessLoadedAt = nil
		localAwarenessHydrated = false
		localAwarenessHydrationStatus = "Not hydrated"
		selectedCloudBinding = nil
		authPhase = .signedOut
		authError = nil
		stopBackend()
		applyRuntimeProfile(.current())
		messages = []
		persistedEventKeys = []
		activity = []
		recordActivity(.status, title: "Signed out", detail: "Using local runtime profile.", symbol: "desktopcomputer")
	}

	func refreshCloudAgents() {
		Task { [weak self] in
			await self?.loadCloudAgents()
		}
	}

	func refreshCloudAwareness() {
		Task { [weak self] in
			await self?.loadCloudAwareness()
		}
	}

	func selectCloudAgent(_ agent: CloudAgent) {
		let binding = CloudAgentBinding(agent: agent, cloudBaseURL: oauth.issuer.absoluteString)
		bindingStore.save(binding)
		selectedCloudBinding = binding
		authError = nil
		applyRuntimeProfile(.cloudBound(binding))
		persistedEventKeys = []
		loadLocalMessagesForCurrentProfile()
		activity = []
		cloudAwareness = []
		cloudAwarenessStatus = "Loading cloud awareness..."
		cloudAwarenessLoaded = false
		cloudAwarenessLoadedAt = nil
		localAwarenessHydrated = false
		localAwarenessHydrationStatus = "Not hydrated"
		recordActivity(.status, title: "\(agent.name) selected", detail: "Starting local runtime.", symbol: "link")
		Task { [weak self] in
			await self?.loadCloudAwareness()
		}
		if authPhase.isSignedIn {
			beginBackendMonitoring()
		}
	}

	func restartBackend(build: Bool = false) {
		guard canUseBoundRuntime else {
			authError = "Sign in before starting the selected cloud agent."
			backend.message = "Cloud agent is not authenticated."
			recordActivity(.error, title: "Runtime blocked", detail: authError ?? "Cloud agent is not authenticated.", symbol: "lock")
			return
		}
		appendLog(build ? "Restarting backend with build." : "Restarting backend.")
		stopVoice()
		backend.state = .starting
		backend.message = "Restarting local backend..."
		phase = .starting
		do {
			try supervisor.restart(build: build, environmentOverrides: runtimeEnvironmentOverrides())
			beginBackendMonitoring()
		} catch {
			backend.state = .crashed
			backend.message = "Restart failed: \(error)"
			phase = .error
		}
	}

	func stopBackend() {
		stopVoice()
		healthTask?.cancel()
		supervisor.stop()
		if !supervisor.isProcessRunning {
			_ = supervisor.reclaimListeningProcessIfOwned()
		}
		backend.state = .stopped
		backend.message = canUseBoundRuntime ? "Stopped." : "Sign in and choose an agent."
		phase = .idle
	}

	func sendDraft() {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { return }
		draft = ""
		send(text)
	}

	func selectVoiceProvider(_ provider: VoiceProviderKind) {
		if provider == selectedVoiceProvider { return }
		stopVoice()
		selectedVoiceProvider = provider
		voiceStatus = "\(provider.title) selected"
		recordActivity(.status, title: "Voice provider", detail: "\(provider.title) - \(provider.detail)", symbol: "waveform")
	}

	func selectRealtimeVoice(_ voice: RealtimeVoice) {
		guard voice != selectedRealtimeVoice else { return }
		guard !isVoiceActive else {
			recordActivity(.status, title: "Voice locked", detail: "Stop Realtime 2 before changing voice.", symbol: "speaker.wave.2")
			return
		}
		selectedRealtimeVoice = voice
		UserDefaults.standard.set(voice.rawValue, forKey: Self.realtimeVoiceDefaultsKey)
		recordActivity(.status, title: "Realtime voice", detail: "\(voice.title) - \(voice.detail)", symbol: "speaker.wave.2")
	}

	func toggleVoice() {
		if isVoiceActive {
			stopVoice()
		} else {
			startVoice()
		}
	}

	func startVoice() {
		guard canUseVoice else {
			authError = profile.isCloudBound ? "Sign in and choose an agent before starting voice." : "Start the local runtime before starting voice."
			recordActivity(.error, title: "Voice blocked", detail: authError ?? "Voice is not ready.", symbol: "mic.slash")
			return
		}
		recordActivity(.status, title: "Voice starting", detail: selectedVoiceProvider.title, symbol: "mic")
		Task { [weak self] in
			guard let self else { return }
			await self.voiceSession.start(
				kind: self.selectedVoiceProvider,
				runtimePort: self.backend.port,
				agentName: self.selectedAgentName,
				realtimeVoice: self.selectedRealtimeVoice,
				localControlToken: self.localControlToken
			)
		}
	}

	func stopVoice() {
		voiceSession.stop()
		voicePartialTranscript = ""
		voiceAssistantMessageID = nil
		if phase != .error && !isSending {
			phase = .idle
		}
	}

	func interruptVoiceOutput() {
		guard isVoiceActive else { return }
		voiceSession.interrupt()
		voicePartialTranscript = ""
		recordActivity(.status, title: "Voice interrupted", detail: selectedVoiceProvider.title, symbol: "stop.circle")
	}

	func send(_ text: String, channelId: String = "mac") {
		guard canUseJarvisChat else {
			authError = profile.isCloudBound ? "Sign in and choose an agent before sending a command." : "Start the local runtime before sending a command."
			recordActivity(
				.error,
				title: "Command blocked",
				detail: authError ?? "No local agent is selected.",
				symbol: "lock"
			)
			return
		}
		guard !isSending else {
			appendLog("A local run is already active. Use Stop or wait for completion.")
			return
		}

		lastTranscript = text
		recordActivity(.input, title: "You", detail: text, symbol: "mic")
		if cloudAwarenessLoaded && localAwarenessHydrated {
			recordActivity(.status, title: "Cloud context available", detail: "\(cloudAwareness.count) recent entries from Crawdad v2", symbol: "cloud")
		}
		let user = ChatMessage(role: .user, text: text)
		let assistant = ChatMessage(role: .assistant, text: "", isStreaming: true)
		messages.append(user)
		messages.append(assistant)
		persistLocalMessages()
		isSending = true
		phase = .thinking

		let assistantID = assistant.id
		sendTask = Task { [weak self] in
			guard let self else { return }
			do {
				let stream = try await self.client.sendMessage(self.runtimeMessage(for: text), agentID: self.selectedAgentID, channelId: channelId)
				for try await event in stream {
					await self.apply(event, to: assistantID)
				}
				await MainActor.run {
					self.finishAssistantMessage(assistantID)
				}
			} catch {
				await MainActor.run {
					self.appendDetail("Error: \(error)", to: assistantID)
					self.finishAssistantMessage(assistantID)
					self.phase = .error
					self.recordActivity(.error, title: "Run failed", detail: String(describing: error), symbol: "exclamationmark.triangle")
				}
			}
		}
	}

	func stopActiveRun() {
		sendTask?.cancel()
		sendTask = nil
		Task {
			do {
				try await client.stop(agentID: selectedAgentID, channelId: "mac")
				await MainActor.run {
					isSending = false
					phase = .idle
					recordActivity(.status, title: "Stop requested", detail: selectedAgentName, symbol: "hand.raised")
					appendLog("Stop requested.")
				}
			} catch {
				await MainActor.run {
					appendLog("Stop failed: \(error)")
				}
			}
		}
	}

	func appendLog(_ line: String) {
		let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }
		logs.append(trimmed)
		if logs.count > 80 {
			logs.removeFirst(logs.count - 80)
		}
	}

	private func bootstrapCloudAuth() async {
		guard let tokens = tokenStore.load(), let cid = clientIDStore.load() else {
			authPhase = .signedOut
			cloudClient = nil
			backend.message = profile.isCloudBound ? "Sign in to use the selected cloud agent." : "Local runtime profile ready."
			return
		}
		clientID = cid
		cloudClient = CloudAgentClient(baseURL: oauth.issuer, clientID: cid, oauth: oauth, tokenStore: tokenStore)
		authPhase = .signedIn(tokenSummary: Self.tokenSummary(tokens.accessToken))
		if selectedCloudBinding == nil {
			messages = []
			activity = []
			recordActivity(.status, title: "Signed in", detail: "Choose an agent.", symbol: "checkmark.seal")
		}
		await loadCloudAgents()
		if selectedCloudBinding != nil {
			await loadCloudAwareness()
		}
	}

	private func loadCloudAgents() async {
		guard let cloudClient else {
			isLoadingCloudAgents = false
			return
		}
		isLoadingCloudAgents = true
		defer { isLoadingCloudAgents = false }
		do {
			let agents = try await cloudClient.listAgents()
			cloudAgents = agents.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
			if let selectedCloudBinding,
			   let fresh = agents.first(where: { $0.id == selectedCloudBinding.id }),
			   fresh.name != selectedCloudBinding.name {
				let updated = CloudAgentBinding(agent: fresh, tenantID: selectedCloudBinding.tenantID, cloudBaseURL: selectedCloudBinding.cloudBaseURL)
				bindingStore.save(updated)
				self.selectedCloudBinding = updated
				applyRuntimeProfile(.cloudBound(updated), stopExisting: false)
			}
			if selectedCloudBinding == nil {
				messages = []
			}
			recordActivity(.status, title: "Agents loaded", detail: "\(agents.count) available", symbol: "person.2")
		} catch {
			authError = "Agent list failed: \(error)"
			recordActivity(.error, title: "Agent list failed", detail: String(describing: error), symbol: "exclamationmark.triangle")
		}
	}

	private func loadCloudAwareness() async {
		guard let cloudClient, let selectedCloudBinding else {
			cloudAwareness = []
			cloudAwarenessStatus = "Choose an agent."
			cloudAwarenessLoaded = false
			cloudAwarenessLoadedAt = nil
			return
		}

		isLoadingCloudAwareness = true
		cloudAwarenessStatus = "Loading \(selectedCloudBinding.name) awareness..."
		defer { isLoadingCloudAwareness = false }

		do {
			let backlog = try await cloudClient.awarenessBacklog(agentID: selectedCloudBinding.id, limit: 200)
			cloudAwareness = backlog.entries
			mergePersistedEvents(backlog.entries)
			cloudAwarenessLoaded = true
			cloudAwarenessLoadedAt = Date()
			if backlog.entries.isEmpty {
				cloudAwarenessStatus = "Cloud awareness is reachable; no entries returned."
			} else {
				cloudAwarenessStatus = "Loaded \(backlog.entries.count) recent cloud entries."
			}
			recordActivity(.status, title: "Cloud awareness loaded", detail: cloudAwarenessStatus, symbol: "cloud")
			await hydrateLocalRuntimeAwarenessIfReady()
		} catch {
			cloudAwareness = []
			cloudAwarenessLoaded = false
			cloudAwarenessLoadedAt = nil
			localAwarenessHydrated = false
			localAwarenessHydrationStatus = "Not hydrated"
			cloudAwarenessStatus = "Cloud awareness failed: \(error)"
			phase = .error
			recordActivity(.error, title: "Cloud awareness failed", detail: String(describing: error), symbol: "cloud.slash")
		}
	}

	private func hydrateLocalRuntimeAwarenessIfReady() async {
		guard canUseBoundRuntime, cloudAwarenessLoaded, !cloudAwareness.isEmpty else {
			localAwarenessHydrated = false
			localAwarenessHydrationStatus = cloudAwareness.isEmpty ? "No cloud entries to hydrate." : "Waiting for runtime."
			return
		}
		guard await client.health() else {
			localAwarenessHydrated = false
			localAwarenessHydrationStatus = "Waiting for runtime."
			return
		}

		let content = cloudAwareness.map(\.raw).joined(separator: "\n") + "\n"
		do {
			try await client.writeFile(path: "awareness/context.jsonl", content: content, agentID: selectedAgentID)
			localAwarenessHydrated = true
			localAwarenessHydrationStatus = "Runtime hydrated from cloud awareness."
			recordActivity(.status, title: "Runtime hydrated", detail: "\(cloudAwareness.count) awareness entries copied into local runtime.", symbol: "arrow.down.doc")
		} catch {
			localAwarenessHydrated = false
			localAwarenessHydrationStatus = "Hydration failed: \(error)"
			recordActivity(.error, title: "Runtime hydration failed", detail: String(describing: error), symbol: "exclamationmark.triangle")
		}
	}

	private func beginBackendMonitoring() {
		healthTask?.cancel()
		healthTask = Task { [weak self] in
			guard let self else { return }
			await self.ensureBackend()
			await self.pollBackendForever()
		}
	}

	private func ensureBackend() async {
		guard canUseBoundRuntime else {
			backend.state = .stopped
			backend.message = "Sign in to use the selected cloud agent."
			phase = .idle
			return
		}

		if await client.health() {
			if let agent = await readRuntimeAgent(), !agentMatchesCurrentProfile(agent) {
				if await reclaimStaleRuntimeAndStart(actual: agent) {
					return
				}
				backend.state = .crashed
				backend.message = runtimeMismatchMessage(actual: agent)
				phase = .error
				recordActivity(.error, title: "Runtime mismatch", detail: backend.message, symbol: "exclamationmark.triangle")
				return
			}
			await discoverSelectedAgent()
			backend.state = .external
			backend.message = "Connected to \(selectedAgentName)."
			phase = .idle
			return
		}

		backend.state = .starting
		backend.message = "Starting local backend..."
		phase = .starting
		do {
			try supervisor.start(
				build: CommandLine.arguments.contains("--build"),
				environmentOverrides: runtimeEnvironmentOverrides()
			)
		} catch {
			backend.state = .crashed
			backend.message = "Failed to start backend: \(error)"
			phase = .error
		}
	}

	private func pollBackendForever() async {
		while !Task.isCancelled {
			guard canUseBoundRuntime else {
				backend.state = .stopped
				backend.message = "Sign in to use the selected cloud agent."
				phase = .idle
				return
			}

			let healthy = await client.health()
			backend.lastHealthCheck = Date()
			if healthy {
				if let agent = await readRuntimeAgent(), !agentMatchesCurrentProfile(agent) {
					if await reclaimStaleRuntimeAndStart(actual: agent) {
						try? await Task.sleep(nanoseconds: 1_500_000_000)
						continue
					}
					backend.state = .crashed
					backend.message = runtimeMismatchMessage(actual: agent)
					phase = .error
					recordActivity(.error, title: "Runtime mismatch", detail: backend.message, symbol: "exclamationmark.triangle")
				} else {
					await discoverSelectedAgent()
					let status = await client.runtimeStatus()
					if cloudAwarenessLoaded && !localAwarenessHydrated {
						await hydrateLocalRuntimeAwarenessIfReady()
					}
					backend.state = status.busy ? .busy : (supervisor.isProcessRunning ? .ready : .external)
					backend.message = status.busy ? "\(selectedAgentName) is using this Mac." : "\(selectedAgentName) local runtime ready."
					backend.activeRunDescription = status.activeRun
					if !isSending && phase == .starting {
						phase = .idle
					}
				}
			} else if supervisor.isProcessRunning {
				backend.state = .starting
				backend.message = "Waiting for backend health..."
				if phase != .error { phase = .starting }
			} else if backend.state != .crashed {
				backend.state = .stopped
				backend.message = "Backend is not running."
				if phase != .error { phase = .idle }
			}
			try? await Task.sleep(nanoseconds: 1_500_000_000)
		}
	}

	@discardableResult
	private func discoverSelectedAgent() async -> LocalAgentClient.Agent? {
		do {
			guard let agent = try await client.agents().first else { return nil }
			selectedAgentID = agent.id
			selectedAgentName = agent.name
			cloudAgentID = agent.cloudAgentID
			tenantID = agent.tenantID
			return agent
		} catch {
			appendLog("Agent discovery failed: \(error)")
			return nil
		}
	}

	private func readRuntimeAgent() async -> LocalAgentClient.Agent? {
		do {
			return try await client.agents().first
		} catch {
			appendLog("Agent discovery failed: \(error)")
			return nil
		}
	}

	private func agentMatchesCurrentProfile(_ agent: LocalAgentClient.Agent) -> Bool {
		guard let expectedCloudAgentID = profile.cloudAgentID else { return true }
		return agent.cloudAgentID == expectedCloudAgentID || agent.id == profile.localAgentID
	}

	private func runtimeMismatchMessage(actual agent: LocalAgentClient.Agent) -> String {
		let expected = profile.cloudAgentID ?? profile.localAgentID
		let actual = agent.cloudAgentID ?? agent.id
		return "Port \(backend.port) is running \(agent.name) (\(actual)), not \(profile.agentName) (\(expected))."
	}

	private func reclaimStaleRuntimeAndStart(actual agent: LocalAgentClient.Agent) async -> Bool {
		appendLog(runtimeMismatchMessage(actual: agent))
		guard supervisor.reclaimListeningProcessIfOwned() else {
			return false
		}
		backend.state = .starting
		backend.message = "Replacing stale local runtime..."
		phase = .starting
		try? await Task.sleep(nanoseconds: 500_000_000)
		do {
			try supervisor.start(
				build: CommandLine.arguments.contains("--build"),
				environmentOverrides: runtimeEnvironmentOverrides()
			)
			return true
		} catch {
			backend.state = .crashed
			backend.message = "Restart failed: \(error)"
			phase = .error
			return true
		}
	}

	private func apply(_ event: RuntimeStreamEvent, to id: UUID) async {
		await MainActor.run {
			switch event.type {
			case "status":
				let message = event.message ?? event.status ?? "Status update"
				appendDetail(message, to: id)
				recordActivity(.status, title: "Status", detail: message, symbol: "bolt.horizontal")
				if phase == .starting { phase = .thinking }
			case "text_delta":
				appendText(event.delta ?? "", to: id)
				phase = .thinking
			case "thinking_delta", "thinking_patch":
				if let delta = event.delta, !delta.isEmpty {
					appendDetail("Thinking: \(delta)", to: id)
					recordActivity(.thinking, title: "Thinking", detail: delta, symbol: "brain")
				}
				phase = .thinking
			case "text", "text_patch":
				let text = event.text ?? ""
				replaceText(text, to: id)
				if !text.isEmpty {
					recordActivity(.assistant, title: selectedAgentName, detail: text, symbol: "text.bubble")
				}
				phase = .speaking
			case "thinking":
				if let thinking = event.thinking, !thinking.isEmpty {
					appendDetail("Thinking complete.", to: id)
					recordActivity(.thinking, title: "Thought", detail: thinking, symbol: "brain")
				}
			case "toolCall":
				let name = event.name ?? event.id ?? "tool"
				appendDetail("Tool: \(name)", to: id)
				recordActivity(.tool, title: "Using \(name)", detail: event.toolCallId ?? event.id ?? "", symbol: "hammer")
				phase = .acting
			case "toolResult", "toolResultDelta":
				let marker = event.isError ? "Tool error" : "Tool result"
				let detail = event.result ?? event.toolCallId ?? ""
				appendDetail("\(marker): \(detail)", to: id)
				recordActivity(event.isError ? .error : .result, title: marker, detail: detail, symbol: event.isError ? "exclamationmark.triangle" : "checkmark.circle")
				phase = .thinking
			case "run_complete":
				finishAssistantMessage(id)
				recordActivity(.status, title: "Done", detail: selectedAgentName, symbol: "checkmark.circle")
				phase = .idle
			case "error":
				let message = event.message ?? "Stream error"
				appendDetail("Error: \(message)", to: id)
				recordActivity(.error, title: "Stream error", detail: message, symbol: "exclamationmark.triangle")
				phase = .error
			case "heartbeat":
				break
			default:
				appendDetail("Event: \(event.type)", to: id)
			}
		}
	}

	private func wireVoiceCallbacks() {
		voiceSession.onStateChange = { [weak self] state, message in
			guard let self else { return }
			self.voiceState = state
			self.voiceStatus = message
			switch state {
			case .connecting:
				self.phase = .starting
			case .listening, .transcribing:
				if !self.isSending { self.phase = .listening }
			case .thinking:
				self.phase = .thinking
			case .speaking:
				self.phase = .speaking
			case .error:
				self.phase = .error
				self.recordActivity(.error, title: "Voice error", detail: message, symbol: "mic.slash")
			case .idle:
				if !self.isSending && self.phase != .error { self.phase = .idle }
			}
		}
		voiceSession.onPartialTranscript = { [weak self] partial in
			guard let self else { return }
			self.voicePartialTranscript = partial
			if !partial.isEmpty {
				self.phase = .listening
			}
		}
		voiceSession.onFinalTranscript = { [weak self] text in
			self?.handleVoiceFinalTranscript(text)
		}
		voiceSession.onAssistantTextDelta = { [weak self] delta in
			self?.appendVoiceAssistantDelta(delta)
		}
		voiceSession.onAssistantTextFinal = { [weak self] text in
			self?.finishVoiceAssistant(text)
		}
	}

	private func handleVoiceFinalTranscript(_ text: String) {
		let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !cleaned.isEmpty else { return }
		lastTranscript = cleaned
		voicePartialTranscript = ""
		recordActivity(.input, title: "Voice", detail: cleaned, symbol: "mic.fill")

		if selectedVoiceProvider == .deepgram {
			send(cleaned, channelId: "mac-voice")
			return
		}

		let user = ChatMessage(role: .user, text: cleaned, details: [selectedVoiceProvider.title])
		messages.append(user)
		if selectedVoiceProvider == .openAIRealtime {
			_ = ensureVoiceAssistantMessage(after: user.id)
		}
		trimMessages()
		persistLocalMessages()
	}

	private func appendVoiceAssistantDelta(_ delta: String) {
		guard !delta.isEmpty else { return }
		let id = ensureVoiceAssistantMessage()
		appendText(delta, to: id)
		phase = .speaking
	}

	private func finishVoiceAssistant(_ text: String) {
		let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
		let id = ensureVoiceAssistantMessage()
		if !cleaned.isEmpty {
			replaceText(cleaned, to: id)
			recordActivity(.assistant, title: selectedVoiceProvider.title, detail: cleaned, symbol: "speaker.wave.2.fill")
		}
		finishAssistantMessage(id, clearSending: false)
		voiceAssistantMessageID = nil
	}

	private func ensureVoiceAssistantMessage(after predecessorID: UUID? = nil) -> UUID {
		if let voiceAssistantMessageID,
		   messages.contains(where: { $0.id == voiceAssistantMessageID }) {
			return voiceAssistantMessageID
		}
		let assistant = ChatMessage(role: .assistant, text: "", details: [selectedVoiceProvider.title], isStreaming: true)
		if let predecessorID,
		   let index = messages.firstIndex(where: { $0.id == predecessorID }) {
			messages.insert(assistant, at: min(messages.count, index + 1))
		} else {
			messages.append(assistant)
		}
		voiceAssistantMessageID = assistant.id
		trimMessages()
		return assistant.id
	}

	private func mergePersistedEvents(_ entries: [CloudAwarenessEntry]) {
		let projected = entries.compactMap { entry -> ChatMessage? in
			let key = "\(entry.id)-\(entry.raw.hashValue)"
			guard !persistedEventKeys.contains(key) else { return nil }
			persistedEventKeys.insert(key)
			return persistedMessage(from: entry)
		}
		guard !projected.isEmpty else { return }
		messages.append(contentsOf: projected)
		sortMessagesChronologically()
		trimMessages()
	}

	private func persistedMessage(from entry: CloudAwarenessEntry) -> ChatMessage {
		let title = entry.title.lowercased()
		let role: ChatMessage.Role
		if title == "user" || title.contains("human") {
			role = .user
		} else if title == "system" {
			role = .system
		} else {
			role = .assistant
		}

		var details: [String] = []
		if let timestamp = entry.timestamp {
			details.append(timestamp)
		}
		details.append("Persisted via Crawdad v2")
		if title.contains("tool") {
			details.append(entry.title)
		}

		var message = ChatMessage(
			role: role,
			text: entry.detail,
			details: details,
			isStreaming: false
		)
		if let timestamp = entry.timestamp,
		   let date = Self.parseCloudTimestamp(timestamp) {
			message.createdAt = date
		}
		return message
	}

	private func applyRuntimeProfile(_ newProfile: TenantRuntimeProfile, stopExisting: Bool = true) {
		if stopExisting {
			healthTask?.cancel()
			supervisor.stop()
		}
		profile = newProfile
		supervisor = RuntimeSupervisor(projectRoot: projectRoot, profile: newProfile)
		wireSupervisorCallbacks()
		client = LocalAgentClient(port: newProfile.port)
		backend.port = newProfile.port
		applyProfileToPublished(newProfile)
		backend.message = newProfile.isCloudBound ? "\(newProfile.agentName) selected." : "Choose an agent."
	}

	private func runtimeEnvironmentOverrides() -> [String: String] {
		var env = [
			"TROUBLEMAKER_LOCAL_CONTROL_TOKEN": localControlToken,
		]
		guard profile.cloudAgentID != nil else {
			return env
		}
		if let token = tokenStore.load()?.accessToken,
		   !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			env["TROUBLEMAKER_CLOUD_ACCESS_TOKEN"] = token
			env["TROUBLEMAKER_REALTIME_AUTH"] = "broker"
		}
		return env
	}

	private func applyProfileToPublished(_ profile: TenantRuntimeProfile) {
		selectedAgentID = profile.localAgentID
		selectedAgentName = profile.agentName
		cloudAgentID = profile.cloudAgentID
		tenantID = profile.tenantID
	}

	private static func makeLocalControlToken() -> String {
		var bytes = [UInt8](repeating: 0, count: 32)
		let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
		let data = status == errSecSuccess ? Data(bytes) : Data(UUID().uuidString.utf8)
		return data.base64EncodedString()
			.replacingOccurrences(of: "+", with: "-")
			.replacingOccurrences(of: "/", with: "_")
			.replacingOccurrences(of: "=", with: "")
	}

	private func wireSupervisorCallbacks() {
		supervisor.onLog = { [weak self] line in
			Task { @MainActor in self?.appendLog(line) }
		}
		supervisor.onExit = { [weak self] status in
			Task { @MainActor in
				guard let self else { return }
				self.backend.state = status == 0 ? .stopped : .crashed
				self.backend.message = status == 0 ? "Backend stopped." : "Backend exited with status \(status)."
				self.phase = status == 0 ? .idle : .error
			}
		}
	}

	private func appendText(_ text: String, to id: UUID) {
		guard !text.isEmpty, let index = messages.firstIndex(where: { $0.id == id }) else { return }
		messages[index].text += text
	}

	private func replaceText(_ text: String, to id: UUID) {
		guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
		if !text.isEmpty {
			messages[index].text = text
		}
	}

	private func appendDetail(_ detail: String, to id: UUID) {
		let cleaned = detail.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !cleaned.isEmpty, let index = messages.firstIndex(where: { $0.id == id }) else { return }
		messages[index].details.append(cleaned)
		if messages[index].details.count > 12 {
			messages[index].details.removeFirst(messages[index].details.count - 12)
		}
	}

	private func trimMessages(limit: Int = 160) {
		guard messages.count > limit else { return }
		let removable = messages.count - limit
		let protectedID = voiceAssistantMessageID
		var removed = 0
		while removed < removable,
			  let index = messages.firstIndex(where: { $0.id != protectedID }) {
			messages.remove(at: index)
			removed += 1
		}
	}

	private var localMessagesURL: URL {
		profile.workspaceURL
			.appendingPathComponent("native-chat", isDirectory: true)
			.appendingPathComponent("messages.json")
	}

	private func loadLocalMessagesForCurrentProfile() {
		messages = Self.loadLocalMessages(from: localMessagesURL)
		trimMessages()
	}

	private func persistLocalMessages() {
		let durableMessages = messages
			.filter { !$0.isStreaming }
			.filter { !$0.details.contains("Persisted via Crawdad v2") }
			.suffix(160)
		Self.persistLocalMessages(Array(durableMessages), to: localMessagesURL)
	}

	private func sortMessagesChronologically() {
		messages = messages.enumerated().sorted { left, right in
			if left.element.createdAt == right.element.createdAt {
				return left.offset < right.offset
			}
			return left.element.createdAt < right.element.createdAt
		}.map(\.element)
	}

	private func finishAssistantMessage(_ id: UUID, clearSending: Bool = true) {
		guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
		if messages[index].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			messages[index].text = messages[index].details.last ?? "Done."
		}
		messages[index].isStreaming = false
		if clearSending {
			isSending = false
		}
		if phase != .error { phase = .idle }
		persistLocalMessages()
	}

	private func recordActivity(_ kind: AssistantActivityItem.Kind, title: String, detail: String, symbol: String) {
		let cleanedDetail = detail.trimmingCharacters(in: .whitespacesAndNewlines)
		activity.append(AssistantActivityItem(kind: kind, title: title, detail: cleanedDetail, symbol: symbol))
		if activity.count > 80 {
			activity.removeFirst(activity.count - 80)
		}
	}

	private func runtimeMessage(for text: String) -> String {
		let lines = cloudAwareness
			.suffix(12)
			.map { entry in
				let detail = entry.detail
					.replacingOccurrences(of: "\n", with: " ")
					.trimmingCharacters(in: .whitespacesAndNewlines)
				return "- [\(entry.title)] \(detail)"
			}
			.joined(separator: "\n")
		guard !lines.isEmpty else { return text }
		return """
Cloud awareness primer for \(selectedAgentName), loaded from TinyFat/Crawdad v2. Treat this as existing agent context for identity and continuity. Do not recite it unless it is directly relevant.

\(lines)

User request:
\(text)
"""
	}

	private static func tokenSummary(_ token: String) -> String {
		String(token.prefix(16)) + "..."
	}

	private static func parseCloudTimestamp(_ raw: String) -> Date? {
		let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		if let date = ISO8601DateFormatter.troublemakerCloudFractional.date(from: trimmed)
			?? ISO8601DateFormatter.troublemakerCloud.date(from: trimmed) {
			return date
		}
		if let numeric = Double(trimmed) {
			let seconds = numeric > 10_000_000_000 ? numeric / 1000.0 : numeric
			return Date(timeIntervalSince1970: seconds)
		}
		return nil
	}

	private static func loadLocalMessages(from url: URL) -> [ChatMessage] {
		guard let data = try? Data(contentsOf: url) else { return [] }
		do {
			return try localMessageDecoder.decode([ChatMessage].self, from: data)
				.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !$0.details.isEmpty }
				.map { message in
					var restored = message
					restored.isStreaming = false
					return restored
				}
		} catch {
			return []
		}
	}

	private static func persistLocalMessages(_ messages: [ChatMessage], to url: URL) {
		do {
			try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
			let data = try localMessageEncoder.encode(messages)
			try data.write(to: url, options: [.atomic])
		} catch {
			// Message persistence should never interrupt a live local run.
		}
	}

	private static let localMessageEncoder: JSONEncoder = {
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
		return encoder
	}()

	private static let localMessageDecoder: JSONDecoder = {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return decoder
	}()
}

private extension ISO8601DateFormatter {
	static let troublemakerCloudFractional: ISO8601DateFormatter = {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return formatter
	}()

	static let troublemakerCloud: ISO8601DateFormatter = {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime]
		return formatter
	}()
}

private struct PendingOAuthAttempt {
	let pkce: OAuthClient.PKCE
	let state: String
	let clientID: String
}

private enum OAuthLaunchError: Error, CustomStringConvertible {
	case browserOpenFailed(String)

	var description: String {
		switch self {
		case let .browserOpenFailed(url):
			return "Could not open OAuth URL in browser: \(url)"
		}
	}
}
