import SwiftUI

struct LoginView: View {
    let viewModel: AppViewModel
    @Binding var isPresented: Bool
    @State private var displayName = ""
    @State private var endpoint = "https://"
    @State private var routeAgentID = "current"
    @State private var capability = ""
    @State private var deepgramKey = ""
    @State private var hasAttemptedSubmit = false
    @FocusState private var focusedField: AgentEnrollmentField?

    private var validation: AgentEnrollmentValidation {
        AgentEnrollmentValidation(
            displayName: displayName,
            endpoint: endpoint,
            routeAgentID: routeAgentID,
            capability: capability
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Agent") {
                    TextField("Display name", text: $displayName)
                        .textContentType(.name)
                        .focused($focusedField, equals: .displayName)
                        .accessibilityIdentifier("enrollment.display-name")
                    inlineError(for: .displayName)
                    TextField("Private HTTPS endpoint", text: $endpoint)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .endpoint)
                        .accessibilityIdentifier("enrollment.endpoint")
                    inlineError(for: .endpoint)
                    TextField("Route agent ID", text: $routeAgentID)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .routeAgentID)
                        .accessibilityIdentifier("enrollment.route-agent-id")
                    inlineError(for: .routeAgentID)
                }
                Section {
                    SecureField("Agent capability", text: $capability)
                        .textContentType(.oneTimeCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .privacySensitive()
                        .focused($focusedField, equals: .capability)
                        .accessibilityIdentifier("enrollment.capability")
                        .accessibilityHint("Paste the existing capability token. Computer does not generate a password.")
                    inlineError(for: .capability)
                    SecureField("Deepgram key (optional)", text: $deepgramKey)
                        .textContentType(.oneTimeCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .privacySensitive()
                        .accessibilityIdentifier("enrollment.deepgram-key")
                } header: {
                    Text("Private credentials")
                } footer: {
                    Text("Paste the existing capability; Computer does not create a password. Deepgram is optional. Both values remain in Keychain and are never relayed to Apple Watch.")
                }

                if viewModel.isEnrolling {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Verifying endpoint and exact agent identity…")
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("enrollment.verifying")
                    }
                } else if let failure = viewModel.enrollmentErrorMessage {
                    Section("Verification failed") {
                        Text(failure)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("enrollment.verification-error")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(.black)
            .navigationTitle("Add Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(viewModel.isEnrolling ? "Checking…" : "Add") { enroll() }
                        .disabled(viewModel.isEnrolling)
                        .accessibilityIdentifier("enrollment.add")
                }
            }
            .onAppear { viewModel.clearEnrollmentFeedback() }
            .onChange(of: displayName) { _, _ in viewModel.clearEnrollmentFeedback() }
            .onChange(of: endpoint) { _, _ in viewModel.clearEnrollmentFeedback() }
            .onChange(of: routeAgentID) { _, _ in viewModel.clearEnrollmentFeedback() }
            .onChange(of: capability) { _, _ in viewModel.clearEnrollmentFeedback() }
            .onChange(of: viewModel.phase) { _, phase in
                if phase == .conversation { isPresented = false }
            }
        }
    }

    @ViewBuilder
    private func inlineError(for field: AgentEnrollmentField) -> some View {
        if hasAttemptedSubmit, let error = validation.error(for: field) {
            Text(error)
                .font(.caption)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("enrollment.\(field.rawValue).error")
        }
    }

    private func enroll() {
        hasAttemptedSubmit = true
        let validation = validation
        guard validation.isValid, let url = validation.baseURL else {
            focusedField = validation.firstInvalidField
            return
        }
        focusedField = nil
        Task {
            await viewModel.enroll(.init(
                displayName: validation.displayName,
                baseURL: url,
                routeAgentID: validation.routeAgentID,
                accessToken: validation.capability,
                deepgramAPIKey: deepgramKey
            ))
        }
    }
}
