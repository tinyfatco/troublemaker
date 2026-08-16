import SwiftUI
import WatchKit

struct WatchRootView: View {
    let bridge: WatchConversationBridge

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 8) {
                    if let snapshot = bridge.snapshot {
                        Text(snapshot.agentName.uppercased())
                            .font(.caption2.weight(.black))
                            .frame(maxWidth: .infinity, alignment: .leading)

                        ForEach(snapshot.messages.suffix(8)) { message in
                            Text(verbatim: message.text)
                                .font(.caption)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(8)
                                .background(message.role == .assistant ? .white : .black)
                                .foregroundStyle(message.role == .assistant ? .black : .white)
                                .overlay {
                                    if message.role == .user { Rectangle().stroke(.white, lineWidth: 1) }
                                    if message.isError { Rectangle().stroke(.red, lineWidth: 2) }
                                }
                                .id(message.id)
                        }

                        if let status = snapshot.statusText, !status.isEmpty {
                            Text(verbatim: status)
                                .font(.caption2.monospaced())
                                .foregroundStyle(snapshot.state == .error ? .red : .secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        WatchOrb(state: snapshot.state)
                            .id("orb")

                        HStack(spacing: 6) {
                            Button(action: dictate) {
                                Label("Talk", systemImage: "mic.fill").labelStyle(.iconOnly)
                            }
                            .tint(.white)
                            .foregroundStyle(.black)
                            .accessibilityLabel("Dictate a prompt")

                            if snapshot.state != .idle {
                                Button(action: bridge.stopAgent) {
                                    Label("Stop", systemImage: "stop.fill").labelStyle(.iconOnly)
                                }
                                .tint(.red)
                                .accessibilityLabel("Stop agent")
                            }
                        }
                    } else {
                        WatchOrb(state: .idle)
                        Text("Open Computer on iPhone and choose an agent.")
                            .font(.caption)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let note = bridge.connectionNote {
                        Text(verbatim: note)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 2)
            }
            .onChange(of: bridge.snapshot?.messages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("orb", anchor: .bottom) }
            }
        }
        .background(.black)
    }

    private func dictate() {
        WKExtension.shared().rootInterfaceController?.presentTextInputController(
            withSuggestions: nil,
            allowedInputMode: .plain
        ) { results in
            guard let text = results?.first as? String else { return }
            Task { @MainActor in bridge.sendPrompt(text) }
        }
    }
}

private struct WatchOrb: View {
    let state: ComputerPresenceState

    var body: some View {
        Circle()
            .fill(AngularGradient(
                colors: [.cyan, .blue, .purple, .pink, .orange, .yellow, .green, .cyan],
                center: .center
            ))
            .overlay(Circle().stroke(.white, lineWidth: state == .listening ? 3 : 1))
            .frame(width: 52, height: 52)
            .scaleEffect(state == .thinking ? 0.92 : state == .listening ? 1.08 : 1)
            .opacity(state == .error ? 0.65 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.72), value: state)
            .accessibilityLabel("Computer is (state.rawValue)")
    }
}
