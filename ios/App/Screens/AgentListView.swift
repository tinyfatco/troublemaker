import SwiftUI

struct AgentListView: View {
    let viewModel: AppViewModel
    @State private var showingEnrollment = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("COMPUTER")
                            .font(.system(size: 34, weight: .black, design: .rounded))
                        Text("Choose exactly one authorized agent.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    if viewModel.bindings.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("NO AGENTS YET")
                                .font(.headline.weight(.black))
                            Text("Add a private agent endpoint and capability. Credentials stay in this iPhone's Keychain.")
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .computerBlock(background: .white, foreground: .black)
                    } else {
                        ForEach(viewModel.bindings) { binding in
                            Button {
                                Task { await viewModel.select(binding) }
                            } label: {
                                HStack(spacing: 14) {
                                    ComputerOrb(state: .idle, diameter: 42)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(binding.displayName)
                                            .font(.headline.weight(.black))
                                        Text(binding.baseURL.host ?? binding.baseURL.absoluteString)
                                            .font(.caption.monospaced())
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    Image(systemName: "arrow.right")
                                        .font(.headline.weight(.black))
                                }
                                .computerBlock(background: .white, foreground: .black)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("Remove", role: .destructive) { viewModel.remove(binding) }
                            }
                            .accessibilityHint("Connects to this exact agent")
                        }
                    }

                    Button {
                        showingEnrollment = true
                    } label: {
                        Label("ADD AUTHORIZED AGENT", systemImage: "plus")
                            .font(.headline.weight(.black))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .overlay(Rectangle().stroke(.white, lineWidth: 2))
                    }
                    .buttonStyle(.plain)
                }
                .padding(20)
            }
            .background(.black)
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showingEnrollment) {
                LoginView(viewModel: viewModel, isPresented: $showingEnrollment)
                    .preferredColorScheme(.dark)
            }
        }
    }
}
