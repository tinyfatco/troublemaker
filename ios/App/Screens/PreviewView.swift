import SwiftUI

struct PushToTalkButton: View {
    let state: ComputerPresenceState
    let isListening: Bool
    let begin: () -> Void
    let end: () -> Void
    @State private var pressing = false

    var body: some View {
        VStack(spacing: 5) {
            ComputerOrb(state: state, diameter: 62)
                .contentShape(Circle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in
                            guard !pressing else { return }
                            pressing = true
                            begin()
                        }
                        .onEnded { _ in
                            guard pressing else { return }
                            pressing = false
                            end()
                        }
                )
            Text(isListening ? "RELEASE TO SEND" : "HOLD TO TALK")
                .font(.caption2.monospaced().weight(.black))
                .foregroundStyle(isListening ? .white : .secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isListening ? "Listening. Release to send." : "Hold to talk")
        .accessibilityAddTraits(.isButton)
    }
}
