import SwiftUI

struct MainChatView: View {
	@EnvironmentObject private var model: AppModel
	@State private var showEmbeddedAgents = false
	@State private var showDiagnostics = false
	let showFloatingChat: () -> Void
	let showOverlay: () -> Void
	let hidePanels: () -> Void

	init(
		showFloatingChat: @escaping () -> Void = {},
		showOverlay: @escaping () -> Void = {},
		hidePanels: @escaping () -> Void = {}
	) {
		self.showFloatingChat = showFloatingChat
		self.showOverlay = showOverlay
		self.hidePanels = hidePanels
	}

	var body: some View {
		HStack(spacing: 0) {
			sidebar
			Divider()
			chat
		}
		.frame(minWidth: 1040, minHeight: 680)
		.background(Color(nsColor: .windowBackgroundColor))
		.toolbar {
			ToolbarItem(placement: .navigation) {
				ToolbarAgentStatusView()
					.environmentObject(model)
			}
			ToolbarItemGroup(placement: .primaryAction) {
				Button {
					showFloatingChat()
				} label: {
					Image(systemName: "macwindow")
				}
				.help("Show floating chat")

				Button {
					showOverlay()
				} label: {
					Image(systemName: "rectangle.inset.filled")
				}
				.help("Show overlay")

				Divider()

				Button {
					model.restartBackend()
				} label: {
					Image(systemName: "arrow.clockwise")
				}
				.help("Restart local runtime")
				.disabled(!model.canUseBoundRuntime)

				Button {
					model.stopActiveRun()
				} label: {
					Image(systemName: "hand.raised.fill")
				}
				.help("Stop active run")
				.disabled(!model.isSending)
			}
		}
	}

	private var sidebar: some View {
		VStack(alignment: .leading, spacing: 14) {
			header
			accountAgentSection
			awarenessSection
			runtimeCompactSection
			panelCompactSection
			Spacer(minLength: 0)
			diagnosticsSection
		}
		.padding(16)
		.frame(width: 280)
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 9) {
				statusDot
				Text(model.selectedCloudBinding?.name ?? "Troublemaker")
					.font(.system(size: 18, weight: .semibold))
					.lineLimit(1)
			}
			Text(statusLine)
				.font(.callout)
				.foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	private var authSection: some View {
		VStack(alignment: .leading, spacing: 9) {
			HStack(spacing: 8) {
				Label(model.authPhase.label, systemImage: authIcon)
					.foregroundStyle(authColor)
				Spacer()
				if model.isLoadingCloudAgents {
					ProgressView()
						.controlSize(.small)
				}
			}
			.font(.caption)

			if let authError = model.authError {
				Text(authError)
					.font(.caption)
					.foregroundStyle(.red)
					.lineLimit(3)
			}

			HStack(spacing: 8) {
				if model.authPhase.isSignedIn {
					Button {
						model.refreshCloudAgents()
					} label: {
						Image(systemName: "arrow.clockwise")
					}
					.help("Refresh agents")

					Button(role: .destructive) {
						model.signOut()
					} label: {
						Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
					}
				} else {
					Button {
						model.signInToTinyFat()
					} label: {
						Label("Sign in to TinyFat", systemImage: "person.badge.key")
					}
					.disabled(model.authPhase == .signingIn || model.authPhase == .loading)
				}
			}
			.buttonStyle(.bordered)
		}
	}

	private var accountAgentSection: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 8) {
				Label(model.authPhase.label, systemImage: authIcon)
					.foregroundStyle(authColor)
					.font(.caption)
				Spacer()
				if model.isLoadingCloudAgents {
					ProgressView()
						.controlSize(.small)
				}
			}

			if let authError = model.authError {
				Text(authError)
					.font(.caption)
					.foregroundStyle(.red)
					.lineLimit(2)
			}

			if model.authPhase.isSignedIn {
				HStack(spacing: 8) {
					Menu {
						ForEach(primaryAgents) { agent in
							Button(agent.name) {
								model.selectCloudAgent(agent)
							}
						}
						if !embeddedAgents.isEmpty {
							Divider()
							Menu("Embedded") {
								ForEach(embeddedAgents) { agent in
									Button(agent.name) {
										model.selectCloudAgent(agent)
									}
								}
							}
						}
					} label: {
						Label(model.selectedCloudBinding?.name ?? "Choose Agent", systemImage: "person.crop.circle")
					}

					Button {
						model.refreshCloudAgents()
					} label: {
						Image(systemName: "arrow.clockwise")
					}
					.help("Refresh agents")

					Button(role: .destructive) {
						model.signOut()
					} label: {
						Image(systemName: "rectangle.portrait.and.arrow.right")
					}
					.help("Sign out")
				}
				.buttonStyle(.bordered)
			} else {
				Button {
					model.signInToTinyFat()
				} label: {
					Label("Sign in", systemImage: "person.badge.key")
				}
				.buttonStyle(.borderedProminent)
				.disabled(model.authPhase == .signingIn || model.authPhase == .loading)
			}
		}
	}

	private var agentSection: some View {
		VStack(alignment: .leading, spacing: 9) {
			sectionTitle("Agent")
			if let binding = model.selectedCloudBinding {
				HStack(spacing: 8) {
					Image(systemName: "checkmark.circle.fill")
						.foregroundStyle(.green)
					VStack(alignment: .leading, spacing: 2) {
						Text(binding.name)
							.font(.system(size: 14, weight: .semibold))
							.lineLimit(1)
						Text(runtimeShortLine)
							.font(.caption2)
							.foregroundStyle(.secondary)
							.lineLimit(1)
					}
					Spacer(minLength: 0)
				}
				.padding(10)
				.background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
			}

			if model.cloudAgents.isEmpty {
				Text(model.authPhase.isSignedIn ? "No agents returned by TinyFat." : "Sign in to choose an agent.")
					.font(.caption)
					.foregroundStyle(.secondary)
					.fixedSize(horizontal: false, vertical: true)
			} else {
				ScrollView {
					VStack(alignment: .leading, spacing: 6) {
						ForEach(primaryAgents) { agent in
							AgentPickerRow(agent: agent, selectedID: model.selectedCloudBinding?.id) {
								model.selectCloudAgent(agent)
							}
						}

						if primaryAgents.isEmpty {
							Text("No primary agents yet.")
								.font(.caption)
								.foregroundStyle(.secondary)
								.padding(.vertical, 4)
						}

						if !embeddedAgents.isEmpty {
							DisclosureGroup(isExpanded: $showEmbeddedAgents) {
								VStack(alignment: .leading, spacing: 6) {
									ForEach(embeddedAgents) { agent in
										AgentPickerRow(agent: agent, selectedID: model.selectedCloudBinding?.id, isEmbedded: true) {
											model.selectCloudAgent(agent)
										}
									}
								}
								.padding(.top, 6)
							} label: {
								Text("Embedded site agents (\(embeddedAgents.count))")
									.font(.caption.weight(.semibold))
									.foregroundStyle(.secondary)
							}
						}
					}
				}
				.frame(maxHeight: 220)
			}
		}
	}

	private var runtimeSection: some View {
		VStack(alignment: .leading, spacing: 9) {
			sectionTitle("Local Runtime")
			HStack(spacing: 8) {
				Circle()
					.fill(runtimeColor)
					.frame(width: 8, height: 8)
				Text(runtimeShortLine)
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(2)
				Spacer(minLength: 0)
			}

			HStack(spacing: 8) {
				Button {
					model.restartBackend()
				} label: {
					Label("Restart", systemImage: "arrow.clockwise")
				}
				.disabled(!model.canUseBoundRuntime)

				Button(role: .destructive) {
					model.stopBackend()
				} label: {
					Label("Stop", systemImage: "stop.fill")
				}
				.disabled(model.backend.state == .stopped)
			}
			.buttonStyle(.bordered)
		}
	}

	private var runtimeCompactSection: some View {
		VStack(alignment: .leading, spacing: 9) {
			sectionTitle("Runtime")
			HStack(spacing: 8) {
				Circle()
					.fill(runtimeColor)
					.frame(width: 8, height: 8)
				Text(runtimeShortLine)
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(1)
				Spacer(minLength: 0)
			}

			HStack(spacing: 8) {
				Button {
					model.restartBackend()
				} label: {
					Image(systemName: "arrow.clockwise")
				}
				.help("Restart runtime")
				.disabled(!model.canUseBoundRuntime)

				Button(role: .destructive) {
					model.stopBackend()
				} label: {
					Image(systemName: "stop.fill")
				}
				.help("Stop runtime")
				.disabled(model.backend.state == .stopped)
			}
			.buttonStyle(.bordered)
		}
	}

	private var awarenessSection: some View {
		VStack(alignment: .leading, spacing: 9) {
			HStack {
				sectionTitle("Cloud Awareness")
				Spacer()
				if model.isLoadingCloudAwareness {
					ProgressView()
						.controlSize(.small)
				}
				Button {
					model.refreshCloudAwareness()
				} label: {
					Image(systemName: "arrow.clockwise")
				}
				.help("Refresh cloud awareness")
				.disabled(!model.canUseBoundRuntime || model.isLoadingCloudAwareness)
			}

			HStack(alignment: .top, spacing: 8) {
				Image(systemName: model.cloudAwarenessLoaded ? "cloud.fill" : "cloud.slash")
					.foregroundStyle(model.cloudAwarenessLoaded ? Color.accentColor : Color.orange)
					.frame(width: 16)
				VStack(alignment: .leading, spacing: 3) {
					Text(model.cloudAwarenessStatus)
						.font(.caption)
						.foregroundStyle(model.cloudAwarenessLoaded ? .secondary : .primary)
						.lineLimit(3)
					if let loadedAt = model.cloudAwarenessLoadedAt {
						Text(loadedAt.formatted(date: .omitted, time: .standard))
							.font(.caption2)
							.foregroundStyle(.secondary)
					}
				}
			}

			HStack(alignment: .top, spacing: 8) {
				Image(systemName: model.localAwarenessHydrated ? "arrow.down.doc.fill" : "arrow.down.doc")
					.foregroundStyle(model.localAwarenessHydrated ? Color.green : Color.secondary)
					.frame(width: 16)
				Text(model.localAwarenessHydrationStatus)
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(2)
			}

			if !model.cloudAwareness.isEmpty {
				VStack(alignment: .leading, spacing: 6) {
					ForEach(model.cloudAwareness.suffix(3)) { entry in
						CloudAwarenessMiniRow(entry: entry)
					}
				}
			}
		}
	}

	private var panelSection: some View {
		VStack(alignment: .leading, spacing: 9) {
			sectionTitle("Panels")
			HStack(spacing: 8) {
				Button {
					showFloatingChat()
				} label: {
					Label("Floating", systemImage: "macwindow")
				}

				Button {
					showOverlay()
				} label: {
					Label("Overlay", systemImage: "rectangle.inset.filled")
				}

				Button {
					hidePanels()
				} label: {
					Image(systemName: "xmark")
				}
				.help("Hide assistant panels")
			}
			.buttonStyle(.bordered)
		}
	}

	private var panelCompactSection: some View {
		VStack(alignment: .leading, spacing: 9) {
			sectionTitle("Panels")
			HStack(spacing: 8) {
				Button {
					showFloatingChat()
				} label: {
					Image(systemName: "macwindow")
				}
				.help("Floating chat")

				Button {
					showOverlay()
				} label: {
					Image(systemName: "rectangle.inset.filled")
				}
				.help("Overlay")

				Button {
					hidePanels()
				} label: {
					Image(systemName: "xmark")
				}
				.help("Hide panels")
			}
			.buttonStyle(.bordered)
		}
	}

	private var diagnosticsSection: some View {
		DisclosureGroup(isExpanded: $showDiagnostics) {
			VStack(alignment: .leading, spacing: 12) {
				VStack(alignment: .leading, spacing: 6) {
					Label("127.0.0.1:\(model.backend.port)", systemImage: "network")
					Label(model.selectedAgentID, systemImage: "person.badge.key")
					if let cloudAgentID = model.cloudAgentID {
						Label(cloudAgentID, systemImage: "cloud")
					}
					if let tenantID = model.tenantID {
						Label(tenantID, systemImage: "building.2")
					}
					if let checked = model.backend.lastHealthCheck {
						Label(checked.formatted(date: .omitted, time: .standard), systemImage: "clock")
					}
				}
				.font(.caption2)
				.foregroundStyle(.secondary)

				if !model.activity.isEmpty {
					VStack(alignment: .leading, spacing: 7) {
						ForEach(model.activity.suffix(5)) { item in
							ActivityRow(item: item)
						}
					}
				}

				if !model.logs.isEmpty {
					ScrollView {
						VStack(alignment: .leading, spacing: 6) {
							ForEach(Array(model.logs.suffix(8).enumerated()), id: \.offset) { _, line in
								Text(line)
									.font(.system(size: 10, design: .monospaced))
									.foregroundStyle(.secondary)
									.frame(maxWidth: .infinity, alignment: .leading)
							}
						}
					}
					.frame(maxHeight: 90)
				}
			}
			.padding(.top, 6)
		} label: {
			Text("Diagnostics")
				.font(.caption.weight(.semibold))
				.foregroundStyle(.secondary)
		}
	}

	private var chat: some View {
		VStack(spacing: 0) {
			ScrollViewReader { proxy in
				ScrollView {
					LazyVStack(alignment: .leading, spacing: 14) {
						if model.messages.isEmpty {
							CloudAwarenessIntroView()
								.environmentObject(model)
						} else {
							ForEach(model.messages) { message in
								ChatBubble(message: message)
									.id(message.id)
							}
						}
					}
					.padding(22)
				}
				.onAppear {
					scrollToLatestAwareness(proxy)
				}
				.onChange(of: model.cloudAwareness) { _, _ in
					scrollToLatestAwareness(proxy)
				}
				.onChange(of: model.messages) { _, messages in
					if let last = messages.last {
						withAnimation(.easeOut(duration: 0.18)) {
							proxy.scrollTo(last.id, anchor: .bottom)
						}
					}
				}
			}

			Divider()
			if model.isVoiceActive || !model.voicePartialTranscript.isEmpty || model.voiceState == .error {
				voiceStatusStrip
				Divider()
			}
			composer
		}
	}

	private var composer: some View {
		HStack(alignment: .bottom, spacing: 12) {
			voiceProviderMenu
			voiceToggleButton

			TextField(composerPlaceholder, text: $model.draft, axis: .vertical)
				.textFieldStyle(.plain)
				.lineLimit(1...4)
				.padding(12)
				.background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
				.disabled(!model.canUseJarvisChat || model.isSending)
				.onSubmit { model.sendDraft() }

			Button {
				model.sendDraft()
			} label: {
				Image(systemName: "paperplane.fill")
					.frame(width: 28, height: 28)
			}
			.buttonStyle(.borderedProminent)
			.disabled(!model.canUseJarvisChat || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
		}
		.padding(18)
	}

	private var voiceStatusStrip: some View {
		HStack(spacing: 10) {
			Image(systemName: voiceIcon)
				.foregroundStyle(voiceColor)
				.frame(width: 18)
			VStack(alignment: .leading, spacing: 2) {
				Text(model.voiceStatus)
					.font(.caption.weight(.semibold))
					.lineLimit(1)
				if !model.voicePartialTranscript.isEmpty {
					Text(model.voicePartialTranscript)
						.font(.caption)
						.foregroundStyle(.secondary)
						.lineLimit(2)
				}
			}
			Spacer()
			Text(model.selectedVoiceProvider.title)
				.font(.caption2)
				.foregroundStyle(.secondary)
		}
		.padding(.horizontal, 18)
		.padding(.vertical, 9)
		.background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
	}

	private var voiceProviderMenu: some View {
		Menu {
			ForEach(VoiceProviderKind.allCases) { provider in
				Button {
					model.selectVoiceProvider(provider)
				} label: {
					Label(provider.title, systemImage: model.selectedVoiceProvider == provider ? "checkmark.circle.fill" : "waveform")
				}
			}
		} label: {
			Image(systemName: "waveform")
				.frame(width: 28, height: 28)
		}
		.menuStyle(.borderlessButton)
		.help("Voice provider")
		.disabled(model.isVoiceActive)
	}

	private var voiceToggleButton: some View {
		Button {
			model.toggleVoice()
		} label: {
			Image(systemName: model.isVoiceActive ? "stop.circle.fill" : "mic.circle.fill")
				.frame(width: 28, height: 28)
		}
		.buttonStyle(.bordered)
		.tint(model.isVoiceActive ? voiceColor : nil)
		.help(model.isVoiceActive ? "Stop voice" : "Start voice")
		.disabled(!model.canUseVoice && !model.isVoiceActive)
	}

	private var statusDot: some View {
		Circle()
			.fill(model.phase.color)
			.frame(width: 12, height: 12)
			.shadow(color: model.phase.color.opacity(0.55), radius: 6)
	}

	private var statusLine: String {
		if !model.authPhase.isSignedIn {
			return "Sign in to TinyFat."
		}
		if model.selectedCloudBinding == nil {
			return "Choose an agent."
		}
		if model.isVoiceActive {
			return "\(model.phase.rawValue) · \(model.voiceStatus)"
		}
		return "\(model.phase.rawValue) · \(model.backend.message)"
	}

	private var chatSubtitle: String {
		if let binding = model.selectedCloudBinding {
			return "\(binding.name) on this Mac"
		}
		return model.authPhase.isSignedIn ? "Choose an agent" : "Sign in to TinyFat"
	}

	private var composerPlaceholder: String {
		if !model.canUseBoundRuntime {
			return "Choose an agent first"
		}
		if !model.cloudAwarenessLoaded {
			return "Load cloud awareness first"
		}
		return model.localAwarenessHydrated ? "Ask the selected agent..." : "Hydrating local runtime..."
	}

	private var primaryAgents: [CloudAgent] {
		model.cloudAgents.filter { !isEmbeddedAgent($0) || $0.id == model.selectedCloudBinding?.id }
	}

	private var embeddedAgents: [CloudAgent] {
		model.cloudAgents.filter { isEmbeddedAgent($0) && $0.id != model.selectedCloudBinding?.id }
	}

	private func isEmbeddedAgent(_ agent: CloudAgent) -> Bool {
		agent.name.lowercased().hasPrefix("embed-")
	}

	private var runtimeShortLine: String {
		switch model.backend.state {
		case .stopped:
			return model.canUseBoundRuntime ? "Stopped" : "Waiting for agent"
		case .starting:
			return "Starting on \(model.backend.port)"
		case .ready, .external:
			return "Ready on \(model.backend.port)"
		case .busy:
			return "Running"
		case .crashed:
			return model.backend.message
		}
	}

	private var runtimeColor: Color {
		switch model.backend.state {
		case .ready, .external: return .green
		case .busy, .starting: return .orange
		case .crashed: return .red
		case .stopped: return .secondary
		}
	}

	private var authIcon: String {
		switch model.authPhase {
		case .loading: return "clock"
		case .signedOut: return "lock"
		case .signingIn: return "arrow.triangle.2.circlepath"
		case .signedIn: return "checkmark.seal"
		}
	}

	private var authColor: Color {
		switch model.authPhase {
		case .loading, .signingIn: return .orange
		case .signedOut: return .secondary
		case .signedIn: return .green
		}
	}

	private var voiceColor: Color {
		switch model.voiceState {
		case .idle: return .secondary
		case .connecting, .thinking: return .orange
		case .listening, .transcribing: return .green
		case .speaking: return .teal
		case .error: return .red
		}
	}

	private var voiceIcon: String {
		switch model.voiceState {
		case .speaking: return "speaker.wave.2.fill"
		case .thinking: return "brain"
		case .error: return "mic.slash"
		case .idle, .connecting, .listening, .transcribing: return "mic.fill"
		}
	}

	private func sectionTitle(_ text: String) -> some View {
		Text(text)
			.font(.caption.weight(.semibold))
			.foregroundStyle(.secondary)
	}

	private func agentBackground(_ agent: CloudAgent) -> Color {
		model.selectedCloudBinding?.id == agent.id ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor).opacity(0.55)
	}

	private func scrollToLatestAwareness(_ proxy: ScrollViewProxy) {
		guard model.messages.isEmpty, !model.cloudAwareness.isEmpty else { return }
		DispatchQueue.main.async {
			withAnimation(.easeOut(duration: 0.18)) {
				proxy.scrollTo("awareness-bottom", anchor: .bottom)
			}
		}
	}
}

struct AgentPickerRow: View {
	let agent: CloudAgent
	let selectedID: String?
	var isEmbedded = false
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: 8) {
				Image(systemName: selectedID == agent.id ? "checkmark.circle.fill" : (isEmbedded ? "globe" : "circle"))
					.foregroundStyle(selectedID == agent.id ? Color.accentColor : Color.secondary)
				VStack(alignment: .leading, spacing: 2) {
					Text(agent.name)
						.font(.system(size: 13, weight: .semibold))
						.lineLimit(1)
					if isEmbedded {
						Text("Embedded site agent")
							.font(.caption2)
							.foregroundStyle(.secondary)
					} else if let status = agent.status, !status.isEmpty {
						Text(status.capitalized)
							.font(.caption2)
							.foregroundStyle(.secondary)
							.lineLimit(1)
					}
				}
				Spacer(minLength: 0)
			}
			.padding(8)
			.background(selectedID == agent.id ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor).opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
		}
		.buttonStyle(.plain)
	}
}

struct CloudAwarenessMiniRow: View {
	let entry: CloudAwarenessEntry

	var body: some View {
		VStack(alignment: .leading, spacing: 3) {
			HStack(spacing: 6) {
				Image(systemName: "quote.bubble")
					.foregroundStyle(.secondary)
					.frame(width: 13)
				Text(entry.title)
					.font(.caption.weight(.semibold))
					.lineLimit(1)
				Spacer(minLength: 0)
			}
			Text(entry.detail)
				.font(.caption2)
				.foregroundStyle(.secondary)
				.lineLimit(2)
		}
		.padding(8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(Color(nsColor: .controlBackgroundColor).opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
	}
}

struct CloudAwarenessIntroView: View {
	@EnvironmentObject private var model: AppModel

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			HStack(alignment: .center, spacing: 10) {
				Image(systemName: model.cloudAwarenessLoaded ? "cloud.fill" : "cloud.slash")
					.font(.title2)
					.foregroundStyle(model.cloudAwarenessLoaded ? Color.accentColor : Color.orange)
				VStack(alignment: .leading, spacing: 3) {
					Text(model.selectedCloudBinding?.name ?? "No Agent Selected")
						.font(.title3.weight(.semibold))
					Text(model.cloudAwarenessStatus)
						.font(.caption)
						.foregroundStyle(.secondary)
				}
				Spacer()
				Button {
					model.refreshCloudAwareness()
				} label: {
					Label("Refresh", systemImage: "arrow.clockwise")
				}
				.buttonStyle(.bordered)
				.disabled(!model.canUseBoundRuntime || model.isLoadingCloudAwareness)
			}

			if model.cloudAwareness.isEmpty {
				Text(model.canUseBoundRuntime ? "Chat stays disabled until cloud awareness loads." : "Sign in and choose an agent.")
					.font(.callout)
					.foregroundStyle(.secondary)
			} else {
				VStack(alignment: .leading, spacing: 8) {
					ForEach(model.cloudAwareness) { entry in
						CloudAwarenessWideRow(entry: entry)
					}
					Color.clear
						.frame(height: 1)
						.id("awareness-bottom")
				}
			}
		}
		.padding(14)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(Color(nsColor: .controlBackgroundColor).opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
	}
}

struct CloudAwarenessWideRow: View {
	let entry: CloudAwarenessEntry

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 8) {
				Text(entry.title)
					.font(.caption.weight(.semibold))
				if let timestamp = entry.timestamp {
					Text(timestamp)
						.font(.caption2)
						.foregroundStyle(.secondary)
						.lineLimit(1)
				}
				Spacer()
			}
			Text(entry.detail)
				.font(.callout)
				.foregroundStyle(.primary)
				.lineLimit(4)
		}
		.padding(.vertical, 4)
	}
}

struct ToolbarAgentStatusView: View {
	@EnvironmentObject private var model: AppModel

	var body: some View {
		HStack(spacing: 8) {
			Circle()
				.fill(model.phase.color)
				.frame(width: 8, height: 8)
			VStack(alignment: .leading, spacing: 0) {
				Text(toolbarTitle)
					.font(.system(size: 13, weight: .semibold))
					.lineLimit(1)
				Text(toolbarSubtitle)
					.font(.system(size: 11))
					.foregroundStyle(.secondary)
					.lineLimit(1)
			}
		}
		.frame(minWidth: 190, alignment: .leading)
		.accessibilityElement(children: .combine)
	}

	private var toolbarTitle: String {
		model.selectedCloudBinding?.name ?? "Troublemaker"
	}

	private var toolbarSubtitle: String {
		if !model.authPhase.isSignedIn {
			return "Signed out"
		}
		if model.selectedCloudBinding == nil {
			return "Choose an agent"
		}
		switch model.backend.state {
		case .ready, .external:
			return "Ready on \(model.backend.port)"
		case .busy:
			return "Using this Mac"
		case .starting:
			return "Starting on \(model.backend.port)"
		case .stopped:
			return "Stopped"
		case .crashed:
			return "Needs attention"
		}
	}
}

struct ActivityRow: View {
	let item: AssistantActivityItem

	var body: some View {
		HStack(alignment: .top, spacing: 8) {
			Image(systemName: item.symbol)
				.frame(width: 15)
				.foregroundStyle(symbolColor)
			VStack(alignment: .leading, spacing: 2) {
				Text(item.title)
					.font(.caption.weight(.semibold))
					.lineLimit(1)
				if !item.detail.isEmpty {
					Text(item.detail)
						.font(.caption2)
						.foregroundStyle(.secondary)
						.lineLimit(2)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private var symbolColor: Color {
		switch item.kind {
		case .error: return .red
		case .tool: return .purple
		case .thinking: return .blue
		case .result: return .green
		case .input: return .accentColor
		case .assistant: return .teal
		case .status: return .secondary
		}
	}
}

struct ChatBubble: View {
	let message: ChatMessage

	var body: some View {
		HStack(alignment: .top) {
			if message.role == .user { Spacer(minLength: 80) }
			VStack(alignment: .leading, spacing: 8) {
				HStack(spacing: 7) {
					Image(systemName: icon)
					Text(title)
						.font(.caption.weight(.semibold))
						.foregroundStyle(.secondary)
					if message.isStreaming {
						ProgressView()
							.controlSize(.small)
							.scaleEffect(0.62)
					}
				}

				Text(message.text)
					.textSelection(.enabled)
					.frame(maxWidth: .infinity, alignment: .leading)

				if !message.details.isEmpty {
					VStack(alignment: .leading, spacing: 5) {
						ForEach(message.details.suffix(5), id: \.self) { detail in
							Text(detail)
								.font(.caption)
								.foregroundStyle(.secondary)
								.lineLimit(3)
						}
					}
					.padding(.top, 2)
				}
			}
			.padding(12)
			.frame(maxWidth: 680, alignment: .leading)
			.background(background, in: RoundedRectangle(cornerRadius: 8))
			.overlay(
				RoundedRectangle(cornerRadius: 8)
					.strokeBorder(Color.primary.opacity(0.08))
			)
			if message.role != .user { Spacer(minLength: 80) }
		}
	}

	private var title: String {
		switch message.role {
		case .user: return "You"
		case .assistant: return "Troublemaker"
		case .system: return "System"
		}
	}

	private var icon: String {
		switch message.role {
		case .user: return "person.crop.circle"
		case .assistant: return "sparkles"
		case .system: return "info.circle"
		}
	}

	private var background: some ShapeStyle {
		switch message.role {
		case .user: return Color.accentColor.opacity(0.14)
		case .assistant: return Color(nsColor: .controlBackgroundColor).opacity(0.9)
		case .system: return Color.orange.opacity(0.10)
		}
	}
}

struct FloatingChatView: View {
	@EnvironmentObject private var model: AppModel

	var body: some View {
		VStack(alignment: .leading, spacing: 7) {
			HStack(spacing: 8) {
				Image(systemName: model.latestActivitySymbol)
					.foregroundStyle(model.phase.color)
				Text(model.latestActivityTitle)
					.font(.headline)
					.lineLimit(1)
				Spacer()
				if model.isSending {
					ProgressView()
						.controlSize(.small)
				}
			}

			Text(model.latestActivityDetail)
				.font(.caption)
				.foregroundStyle(.secondary)
				.lineLimit(2)

			HStack(spacing: 8) {
				TextField(floatingPlaceholder, text: $model.draft)
					.textFieldStyle(.roundedBorder)
					.disabled(!model.canUseJarvisChat || model.isSending)
					.onSubmit { model.sendDraft() }
				Button {
					model.toggleVoice()
				} label: {
					Image(systemName: model.isVoiceActive ? "stop.circle.fill" : "mic.circle.fill")
				}
				.buttonStyle(.bordered)
				.help(model.isVoiceActive ? "Stop voice" : "Start voice")
				.disabled(!model.canUseVoice && !model.isVoiceActive)
				Button {
					model.sendDraft()
				} label: {
					Image(systemName: "paperplane.fill")
				}
				.buttonStyle(.borderedProminent)
				.disabled(!model.canUseJarvisChat || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
			}
		}
		.padding(.horizontal, 12)
		.padding(.vertical, 9)
		.background(.regularMaterial)
	}

	private var floatingPlaceholder: String {
		if !model.canUseBoundRuntime {
			return "Choose an agent first"
		}
		return model.cloudAwarenessLoaded ? "Say it or type it..." : "Load cloud awareness first"
	}
}

struct LiquidGlassOverlayView: View {
	@EnvironmentObject private var model: AppModel

	var body: some View {
		HStack(spacing: 14) {
			Image(systemName: model.latestActivitySymbol)
				.font(.system(size: 28, weight: .semibold))
				.foregroundStyle(model.phase.color)
				.shadow(color: model.phase.color.opacity(0.5), radius: 8)

			VStack(alignment: .leading, spacing: 4) {
				HStack(spacing: 8) {
					Text(model.latestActivityTitle)
						.font(.system(size: 17, weight: .semibold))
						.lineLimit(1)
					Capsule()
						.fill(model.phase.color)
						.frame(width: 8, height: 8)
				}
				Text(overlayLine)
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(1)
			}

			Spacer(minLength: 0)
		}
		.padding(.horizontal, 18)
		.padding(.vertical, 14)
		.frame(width: 540, height: 78)
		.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
		.overlay(
			RoundedRectangle(cornerRadius: 8)
				.strokeBorder(Color.white.opacity(0.22))
		)
	}

	private var overlayLine: String {
		if !model.lastTranscript.isEmpty && model.phase != .idle {
			return model.lastTranscript
		}
		return model.latestActivityDetail
	}
}
