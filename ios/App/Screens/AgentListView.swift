import SwiftUI

public struct AgentListView: View {
    let viewModel: AppViewModel
    @State private var agents: [Agent] = []
    @State private var error: String?
    @State private var loading = false

    public init(viewModel: AppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        NavigationStack {
            List {
                ForEach(agents) { agent in
                    NavigationLink(value: agent) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(agent.name).font(.body.weight(.medium))
                            if let status = agent.status {
                                Text(status).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .overlay {
                if loading && agents.isEmpty { ProgressView() }
            }
            .refreshable { await reload() }
            .navigationTitle("Agents")
            .navigationDestination(for: Agent.self) { agent in
                AgentDetailView(viewModel: viewModel, agent: agent)
            }
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { viewModel.signOut() }
                }
                #else
                ToolbarItem { Button("Sign out") { viewModel.signOut() } }
                #endif
            }
            .task { await reload() }
            .alert("Error", isPresented: .init(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
        }
    }

    private func reload() async {
        guard let api = viewModel.api else { return }
        loading = true
        defer { loading = false }
        do {
            agents = try await api.listAgents()
        } catch {
            self.error = String(describing: error)
        }
    }
}
