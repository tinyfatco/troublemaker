import SwiftUI

struct RootView: View {
    @State private var viewModel = AppViewModel()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch viewModel.phase {
            case .loading:
                VStack(spacing: 18) {
                    ComputerOrb(state: .idle, diameter: 64)
                    ProgressView().tint(.white)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Loading Computer")
            case .choosing:
                AgentListView(viewModel: viewModel)
            case .conversation:
                if let controller = viewModel.conversation {
                    AgentDetailView(
                        controller: controller,
                        onChooseAgent: viewModel.showChooser
                    )
                } else {
                    AgentListView(viewModel: viewModel)
                }
            }
        }
        .task { await viewModel.bootstrap() }
        .alert(
            "Computer",
            isPresented: Binding(
                get: { viewModel.errorMessage != nil },
                set: { if !$0 { viewModel.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }
}
