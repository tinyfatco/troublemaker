import SwiftUI

struct ChatEntry: Identifiable, Equatable {
    let id: String
    let kind: Kind
    let text: String
    let userName: String?
    enum Kind: Equatable { case user, assistant, awareness, system }

    static func from(_ line: AwarenessLine) -> ChatEntry? {
        switch line.kind {
        case .session:
            return ChatEntry(id: line.id, kind: .system, text: "— session —", userName: nil)
        case .message:
            let text = line.displayText
            guard !text.isEmpty else { return nil }
            switch line.role {
            case .user:        return ChatEntry(id: line.id, kind: .user, text: text, userName: line.userName)
            case .assistant:   return ChatEntry(id: line.id, kind: .assistant, text: text, userName: nil)
            case .toolResult:  return ChatEntry(id: line.id, kind: .awareness, text: text, userName: nil)
            case nil:          return nil
            }
        }
    }
}

@Observable
@MainActor
final class ChatModel {
    var entries: [ChatEntry] = []
    var input: String = ""
    var streamingTask: Task<Void, Never>?
    var awarenessTask: Task<Void, Never>?
    var backlogTask: Task<Void, Never>?
    var sending = false
    var status: String?

    /// Stable order: we key on the line id, but only de-dupe — never reorder
    /// (the server hands us backlog in chronological order, SSE appends).
    private var seen = Set<String>()

    func loadBacklog(api: ApiClient, agentID: String) {
        backlogTask?.cancel()
        status = "Loading…"
        backlogTask = Task {
            do {
                let backlog = try await api.eventsBacklog(agentID: agentID, limit: 50)
                let parsed = backlog.lines.compactMap(AwarenessDecoder.parse)
                let new = parsed.compactMap(ChatEntry.from).filter { seen.insert($0.id).inserted }
                entries.insert(contentsOf: new, at: 0)
                status = nil
            } catch {
                status = "Backlog failed: \(shortError(error))"
            }
        }
    }

    func startAwareness(api: ApiClient, agentID: String) {
        awarenessTask?.cancel()
        awarenessTask = Task {
            do {
                let stream = try await AwarenessStream(api: api).subscribe(agentID: agentID)
                for try await event in stream {
                    if Task.isCancelled { break }
                    guard let line = AwarenessDecoder.parse(event.data),
                          let entry = ChatEntry.from(line),
                          seen.insert(entry.id).inserted else { continue }
                    entries.append(entry)
                }
            } catch {
                status = "Awareness disconnected: \(shortError(error))"
            }
        }
    }

    func send(api: ApiClient, agentID: String) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        input = ""
        sending = true

        // Optimistic local echo. The durable user entry will arrive later
        // via the awareness backlog/stream with a real id.
        let userTempID = "local-user-\(UUID().uuidString)"
        entries.append(ChatEntry(id: userTempID, kind: .user, text: text, userName: "you"))

        // Empty assistant placeholder we mutate as text_delta events arrive.
        let assistantTempID = "local-asst-\(UUID().uuidString)"
        let assistantIndex = entries.count
        entries.append(ChatEntry(id: assistantTempID, kind: .assistant, text: "", userName: nil))

        var assistantText = ""
        status = nil

        streamingTask?.cancel()
        streamingTask = Task {
            do {
                let stream = try await MessageStream(api: api).send(
                    agentID: agentID,
                    message: .init(message: text)
                )
                for try await event in stream {
                    if Task.isCancelled { break }
                    guard let delta = MessageDelta.parse(event.data) else { continue }
                    switch delta {
                    case .status(let s):
                        // Suppress noisy intermediate transitions; show wake/connect only.
                        if s == "waking" { status = "Waking runtime…" }
                        else if s == "connecting" || s == "worker" || s == "container" { status = "Connecting…" }
                        else if s == "streaming" || s == "fallback" || s == "steering" { status = nil }

                    case .textDelta(let chunk):
                        assistantText += chunk
                        if entries.indices.contains(assistantIndex) {
                            entries[assistantIndex] = ChatEntry(
                                id: assistantTempID, kind: .assistant, text: assistantText, userName: nil
                            )
                        }

                    case .textFinal(let full):
                        assistantText = full
                        if entries.indices.contains(assistantIndex) {
                            entries[assistantIndex] = ChatEntry(
                                id: assistantTempID, kind: .assistant, text: assistantText, userName: nil
                            )
                        }

                    case .thinkingDelta, .thinkingFinal:
                        // Thinking is hidden in the bubble view for now; backlog/awareness still surfaces it.
                        break

                    case .toolCall(_, let name, _):
                        status = "Running \(name)…"

                    case .toolResult:
                        status = nil

                    case .error(let msg):
                        if assistantText.isEmpty, entries.indices.contains(assistantIndex) {
                            entries[assistantIndex] = ChatEntry(
                                id: assistantTempID, kind: .assistant, text: "⚠︎ " + msg, userName: nil
                            )
                        }
                        status = msg

                    case .heartbeat, .runComplete, .unknown:
                        break
                    }
                }
                status = nil
            } catch {
                status = "Send failed: \(shortError(error))"
            }
            sending = false
        }
    }

    func stop(api: ApiClient, agentID: String) {
        Task { try? await api.stopActiveMessage(agentID: agentID) }
        streamingTask?.cancel()
        sending = false
    }

    func cancelAll() {
        streamingTask?.cancel()
        awarenessTask?.cancel()
        backlogTask?.cancel()
    }

    private func shortError(_ e: Swift.Error) -> String {
        let s = String(describing: e)
        return s.count > 120 ? String(s.prefix(120)) + "…" : s
    }
}

struct ChatView: View {
    let viewModel: AppViewModel
    let agent: Agent
    @State private var model = ChatModel()

    var body: some View {
        VStack(spacing: 0) {
            if let status = model.status {
                Text(status)
                    .font(.caption2)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity)
                    .background(Color.secondary.opacity(0.1))
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        if model.entries.isEmpty {
                            Text("No messages yet.")
                                .foregroundStyle(.secondary)
                                .font(.callout)
                                .padding(.top, 60)
                                .frame(maxWidth: .infinity)
                        }
                        ForEach(model.entries) { entry in
                            row(entry).id(entry.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: model.entries.count) { _, _ in
                    if let last = model.entries.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
            composer
        }
        .onAppear {
            if let api = viewModel.api {
                model.loadBacklog(api: api, agentID: agent.id)
                model.startAwareness(api: api, agentID: agent.id)
            }
        }
        .onDisappear { model.cancelAll() }
    }

    @ViewBuilder
    private func row(_ entry: ChatEntry) -> some View {
        switch entry.kind {
        case .user:
            HStack {
                Spacer(minLength: 32)
                VStack(alignment: .trailing, spacing: 2) {
                    if let name = entry.userName {
                        Text(name).font(.caption2).foregroundStyle(.secondary)
                    }
                    Text(entry.text)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color.accentColor.opacity(0.15), in: .rect(cornerRadius: 12))
                }
            }
        case .assistant:
            HStack(alignment: .top) {
                Text(entry.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.secondary.opacity(0.1), in: .rect(cornerRadius: 12))
                Spacer(minLength: 32)
            }
        case .awareness:
            Text(entry.text)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .system:
            Text(entry.text)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 4)
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message…", text: $model.input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
            if model.sending {
                Button {
                    if let api = viewModel.api { model.stop(api: api, agentID: agent.id) }
                } label: { Image(systemName: "stop.circle.fill").font(.title2) }
            } else {
                Button {
                    if let api = viewModel.api { model.send(api: api, agentID: agent.id) }
                } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                .disabled(model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(8)
        .background(.bar)
    }
}
