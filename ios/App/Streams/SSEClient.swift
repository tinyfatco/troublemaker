import Foundation

/// Minimal Server-Sent Events reader built on URLSession's bytes API.
///
/// The crawdad-cf server emits standard SSE: `event:` line (optional),
/// one or more `data:` lines, terminated by an empty line. We yield one
/// `SSEEvent` per record.
///
/// Reconnection is the caller's responsibility — keep iterating the stream and
/// re-create it on failure. For the awareness stream we use `Last-Event-Id`
/// header (caller-managed) to resume.
public struct SSEClient {
    let session: URLSession
    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func events(for request: URLRequest) -> AsyncThrowingStream<SSEEvent, Swift.Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = request
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        throw ApiError.http(
                            status: (resp as? HTTPURLResponse)?.statusCode ?? 0,
                            body: "SSE handshake failed"
                        )
                    }

                    var eventName: String?
                    var eventID: String?
                    var dataLines: [String] = []

                    for try await line in bytes.lines {
                        if Task.isCancelled { break }

                        if line.isEmpty {
                            // dispatch
                            if !dataLines.isEmpty || eventName != nil {
                                continuation.yield(
                                    SSEEvent(event: eventName, data: dataLines.joined(separator: "\n"), id: eventID)
                                )
                            }
                            eventName = nil
                            eventID = nil
                            dataLines = []
                            continue
                        }

                        if line.hasPrefix(":") { continue } // comment

                        guard let colon = line.firstIndex(of: ":") else {
                            // field name with no value
                            continue
                        }
                        let field = String(line[..<colon])
                        var value = String(line[line.index(after: colon)...])
                        if value.hasPrefix(" ") { value.removeFirst() }

                        switch field {
                        case "event": eventName = value
                        case "data":  dataLines.append(value)
                        case "id":    eventID = value
                        default:      break
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
