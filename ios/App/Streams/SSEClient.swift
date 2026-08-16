import Foundation

struct SSEClient: Sendable {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func events(for request: URLRequest) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = request
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { throw MobileAPIError.invalidResponse }
                    guard (200..<300).contains(http.statusCode) else {
                        var body = ""
                        for try await line in bytes.lines {
                            body += line
                            if body.count >= 4_096 { break }
                        }
                        throw MobileAPIError.http(status: http.statusCode, body: body)
                    }

                    var parser = SSELineParser()
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        for payload in parser.consume(line) {
                            continuation.yield(.init(data: payload.data, id: payload.id))
                        }
                    }
                    for payload in parser.finish() {
                        continuation.yield(.init(data: payload.data, id: payload.id))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
