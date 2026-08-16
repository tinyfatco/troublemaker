import SwiftUI

struct AgentDetailView: View {
    let controller: ConversationController
    let onChooseAgent: () -> Void

    var body: some View {
        NavigationStack {
            ChatView(controller: controller)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(action: onChooseAgent) {
                            Image(systemName: "person.2")
                        }
                        .accessibilityLabel("Choose agent")
                    }
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 0) {
                            Text(controller.binding.displayName.uppercased())
                                .font(.caption.weight(.black))
                            Text(controller.presenceState.rawValue.uppercased())
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if controller.presenceState != .idle {
                            Button(action: controller.stopAgent) {
                                Image(systemName: "stop.fill")
                            }
                            .accessibilityLabel("Stop agent and speech")
                        }
                    }
                }
        }
    }
}
