import Foundation

struct RuntimeStreamEvent: Equatable {
	let type: String
	let status: String?
	let message: String?
	let delta: String?
	let text: String?
	let thinking: String?
	let id: String?
	let name: String?
	let toolCallId: String?
	let result: String?
	let isError: Bool

	static func parse(_ raw: String) -> RuntimeStreamEvent? {
		guard raw != "[DONE]",
			  let data = raw.data(using: .utf8),
			  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			  let type = object["type"] as? String else {
			return nil
		}

		return RuntimeStreamEvent(
			type: type,
			status: object["status"] as? String,
			message: object["message"] as? String,
			delta: object["delta"] as? String,
			text: object["text"] as? String,
			thinking: object["thinking"] as? String,
			id: object["id"] as? String,
			name: object["name"] as? String,
			toolCallId: object["toolCallId"] as? String,
			result: describe(object["result"]),
			isError: object["isError"] as? Bool ?? false
		)
	}

	private static func describe(_ value: Any?) -> String? {
		guard let value else { return nil }
		if let string = value as? String { return string }
		if JSONSerialization.isValidJSONObject(value),
		   let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
		   let string = String(data: data, encoding: .utf8) {
			return string
		}
		return "\(value)"
	}
}

struct LocalAgentClient {
	struct Agent: Equatable {
		let id: String
		let name: String
		let cloudAgentID: String?
		let tenantID: String?
	}

	let baseURL: URL
	let session: URLSession

	init(port: Int = 3017) {
		baseURL = URL(string: "http://127.0.0.1:\(port)")!
		let config = URLSessionConfiguration.default
		config.timeoutIntervalForRequest = 8
		config.timeoutIntervalForResource = 600
		session = URLSession(configuration: config)
	}

	func health() async -> Bool {
		do {
			let (data, response) = try await session.data(from: baseURL.appendingPathComponent("health"))
			guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
				return false
			}
			return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) == "ok"
		} catch {
			return false
		}
	}

	func agents() async throws -> [Agent] {
		let (data, response) = try await session.data(from: baseURL.appendingPathComponent("api/v2/agents"))
		try assertOK(response, data: data)
		guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			  let rawAgents = object["agents"] as? [[String: Any]] else {
			return []
		}
		return rawAgents.compactMap { raw in
			guard let id = raw["id"] as? String else { return nil }
			return Agent(
				id: id,
				name: raw["name"] as? String ?? id,
				cloudAgentID: raw["cloud_agent_id"] as? String,
				tenantID: raw["tenant_id"] as? String
			)
		}
	}

	func runtimeStatus() async -> (busy: Bool, activeRun: String?) {
		do {
			let (data, response) = try await session.data(from: baseURL.appendingPathComponent("status"))
			guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
				  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
				return (false, nil)
			}
			let idle = object["idle"] as? Bool ?? true
			let activeRun = RuntimeStreamEvent.parseDescription(object["activeRun"])
			return (!idle, activeRun)
		} catch {
			return (false, nil)
		}
	}

	func sendMessage(_ message: String, agentID: String, channelId: String = "mac") async throws -> AsyncThrowingStream<RuntimeStreamEvent, Error> {
		var request = URLRequest(url: baseURL.appendingPathComponent("api/v2/agents/\(agentID)/messages"))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
		request.httpBody = try JSONSerialization.data(withJSONObject: [
			"message": message,
			"channelId": channelId,
			"source": "troublemaker-mac",
		])
		return events(for: request)
	}

	func writeFile(path: String, content: String, agentID: String) async throws {
		var request = URLRequest(url: baseURL.appendingPathComponent("api/v2/agents/\(agentID)/file"))
		request.httpMethod = "PUT"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: [
			"path": path,
			"content": content,
		])
		let (data, response) = try await session.data(for: request)
		try assertOK(response, data: data)
	}

	func stop(agentID: String, channelId: String = "mac") async throws {
		var request = URLRequest(url: baseURL.appendingPathComponent("api/v2/agents/\(agentID)/messages/stop"))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: ["channelId": channelId])
		let (data, response) = try await session.data(for: request)
		try assertOK(response, data: data)
	}

	private func events(for request: URLRequest) -> AsyncThrowingStream<RuntimeStreamEvent, Error> {
		AsyncThrowingStream { continuation in
			let task = Task {
				do {
					let (bytes, response) = try await session.bytes(for: request)
					try assertOK(response, data: Data())

					var dataLines: [String] = []
					func emit(_ raw: String) -> Bool {
						if raw == "[DONE]" {
							continuation.finish()
							return true
						}
						if let event = RuntimeStreamEvent.parse(raw) {
							continuation.yield(event)
						}
						return false
					}

					for try await line in bytes.lines {
						if Task.isCancelled { break }
						if line.isEmpty {
							if !dataLines.isEmpty {
								let raw = dataLines.joined(separator: "\n")
								if emit(raw) { return }
							}
							dataLines = []
							continue
						}
						if line.hasPrefix(":") { continue }
						guard let colon = line.firstIndex(of: ":") else { continue }
						let field = String(line[..<colon])
						var value = String(line[line.index(after: colon)...])
						if value.hasPrefix(" ") { value.removeFirst() }
						if field == "data" {
							// Troublemaker emits one JSON payload per `data:` line. Some
							// URLSession line streams do not surface the blank separator,
							// so emit complete single-line payloads immediately.
							if value == "[DONE]" || value.hasPrefix("{") {
								if emit(value) { return }
								dataLines = []
							} else {
								dataLines.append(value)
							}
						}
					}
					if !dataLines.isEmpty {
						_ = emit(dataLines.joined(separator: "\n"))
					}
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}

	private func assertOK(_ response: URLResponse, data: Data) throws {
		guard let http = response as? HTTPURLResponse else { throw LocalAgentError.notHTTP }
		guard (200..<300).contains(http.statusCode) else {
			throw LocalAgentError.http(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
		}
	}
}

private extension RuntimeStreamEvent {
	static func parseDescription(_ value: Any?) -> String? {
		guard let value else { return nil }
		if let string = value as? String { return string }
		if JSONSerialization.isValidJSONObject(value),
		   let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
		   let string = String(data: data, encoding: .utf8) {
			return string
		}
		return "\(value)"
	}
}

enum LocalAgentError: Error, CustomStringConvertible {
	case notHTTP
	case http(status: Int, body: String)

	var description: String {
		switch self {
		case .notHTTP:
			return "Response was not HTTP."
		case let .http(status, body):
			return "HTTP \(status): \(body)"
		}
	}
}
