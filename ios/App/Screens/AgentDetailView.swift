import SwiftUI

/// Tabbed shell for one agent: Chat / Files / Preview.
public struct AgentDetailView: View {
    let viewModel: AppViewModel
    let agent: Agent

    public init(viewModel: AppViewModel, agent: Agent) {
        self.viewModel = viewModel
        self.agent = agent
    }

    public var body: some View {
        TabView {
            ChatView(viewModel: viewModel, agent: agent)
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
            FilesView(viewModel: viewModel, agent: agent)
                .tabItem { Label("Files", systemImage: "folder") }
            PreviewView(viewModel: viewModel, agent: agent)
                .tabItem { Label("Preview", systemImage: "rectangle.dashed.badge.record") }
        }
        .navigationTitle(agent.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
