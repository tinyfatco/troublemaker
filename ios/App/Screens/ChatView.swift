import SwiftUI

struct ChatView: View {
    let controller: ConversationController
    @State private var previousCount = 0

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if controller.messages.isEmpty {
                            Text("This exact agent's conversation will appear here.")
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, minHeight: 220)
                                .padding(.top, 60)
                        }
                        ForEach(controller.messages) { message in
                            ConversationBlock(message: message)
                                .id(message.id)
                        }
                        if let status = controller.statusText, !status.isEmpty {
                            StatusBlock(text: status, isError: controller.lastError != nil)
                                .id("status")
                        }
                        if controller.isListening, !controller.transcriptPreview.isEmpty {
                            Text(controller.transcriptPreview)
                                .computerBlock(background: .black, foreground: .white)
                                .overlay(Rectangle().stroke(.white.opacity(0.35), lineWidth: 1))
                                .id("transcript")
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: controller.messages.count) { _, count in
                    previousCount = count
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: controller.statusText) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onAppear {
                    previousCount = controller.messages.count
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }

            if let notice = controller.deliveryNotice {
                Text(notice.uppercased())
                    .font(.caption2.monospaced().weight(.bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                    .background(.white)
                    .foregroundStyle(.black)
            }

            VStack(spacing: 10) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(
                        "",
                        text: Binding(get: { controller.input }, set: { controller.input = $0 }),
                        prompt: Text("Message \(controller.binding.displayName)").foregroundStyle(.gray),
                        axis: .vertical
                    )
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(.white)
                    .foregroundStyle(.black)
                    .tint(.black)
                    .submitLabel(.send)
                    .onSubmit(controller.sendCurrentInput)

                    Button(action: controller.sendCurrentInput) {
                        Image(systemName: "arrow.up")
                            .font(.headline.weight(.black))
                            .frame(width: 44, height: 44)
                            .background(.white)
                            .foregroundStyle(.black)
                    }
                    .disabled(controller.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send message")
                }

                HStack(spacing: 14) {
                    Spacer()
                    PushToTalkButton(
                        state: controller.presenceState,
                        isListening: controller.isListening,
                        begin: controller.beginPushToTalk,
                        end: controller.endPushToTalk
                    )
                    Spacer()
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(.black)
            .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.18)).frame(height: 1) }
        }
        .background(.black)
    }
}

private struct ConversationBlock: View {
    let message: ConversationMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(message.role == .user ? (message.userName?.uppercased() ?? "YOU") : "COMPUTER")
                .font(.caption2.monospaced().weight(.black))
                .opacity(0.64)
            Text(verbatim: message.text)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .computerBlock(
            background: message.role == .assistant ? .white : .black,
            foreground: message.role == .assistant ? .black : .white
        )
        .overlay {
            if message.role == .user { Rectangle().stroke(.white, lineWidth: 1) }
            if message.isError { Rectangle().stroke(.red, lineWidth: 2) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct StatusBlock: View {
    let text: String
    let isError: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "ellipsis")
            Text(verbatim: text).fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption.monospaced())
        .padding(.vertical, 6)
        .foregroundStyle(isError ? .red : .secondary)
        .accessibilityElement(children: .combine)
    }
}
