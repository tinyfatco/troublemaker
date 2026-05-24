import SwiftUI

public struct FilesView: View {
    let viewModel: AppViewModel
    let agent: Agent
    @State private var path: [String] = []   // breadcrumb
    @State private var entries: [FileNode] = []
    @State private var error: String?
    @State private var loading = false

    public init(viewModel: AppViewModel, agent: Agent) {
        self.viewModel = viewModel
        self.agent = agent
    }

    private var currentPath: String { path.joined(separator: "/") }

    public var body: some View {
        NavigationStack {
            List {
                if !path.isEmpty {
                    Button {
                        path.removeLast()
                        Task { await reload() }
                    } label: {
                        Label("..", systemImage: "arrow.uturn.up")
                    }
                }
                ForEach(entries, id: \.path) { node in
                    Button {
                        select(node)
                    } label: {
                        HStack {
                            Image(systemName: node.type == "directory" ? "folder.fill" : "doc.text")
                            Text(node.name)
                            Spacer()
                            if let size = node.size, node.type != "directory" {
                                Text(formatBytes(size)).foregroundStyle(.secondary).font(.caption)
                            }
                        }
                    }
                }
            }
            .overlay { if loading && entries.isEmpty { ProgressView() } }
            .navigationTitle(path.isEmpty ? "/" : "/" + currentPath)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .task { await reload() }
            .refreshable { await reload() }
            .alert("Error", isPresented: .init(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(error ?? "") }
        }
    }

    private func select(_ node: FileNode) {
        if node.type == "directory" {
            path.append(node.name)
            Task { await reload() }
        } else {
            // Future: push a FileReaderView. Out of MVP scope for first commit.
        }
    }

    private func reload() async {
        guard let api = viewModel.api else { return }
        loading = true
        defer { loading = false }
        do {
            entries = try await api.listFiles(agentID: agent.id, path: currentPath)
        } catch {
            self.error = String(describing: error)
        }
    }

    private func formatBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
