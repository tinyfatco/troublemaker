import SwiftUI

public struct RootView: View {
    @State private var viewModel = AppViewModel()

    public init() {}

    public var body: some View {
        Group {
            switch viewModel.phase {
            case .loading:
                ProgressView()
            case .signedOut:
                LoginView(viewModel: viewModel)
            case .signedIn:
                AgentListView(viewModel: viewModel)
            }
        }
        .task { await viewModel.bootstrap() }
    }
}
