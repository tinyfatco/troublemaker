import Foundation

struct CloudAgent: Sendable, Codable, Identifiable, Equatable, Hashable {
	let id: String
	let name: String
	let status: String?
}

struct CloudAwarenessEntry: Sendable, Identifiable, Equatable, Hashable {
	let id: String
	let title: String
	let detail: String
	let raw: String
	let timestamp: String?

	static func parse(_ line: String, index: Int) -> CloudAwarenessEntry {
		guard let data = line.data(using: .utf8),
			  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			return CloudAwarenessEntry(
				id: "raw-\(index)-\(line.hashValue)",
				title: "Awareness",
				detail: truncate(line, max: 360),
				raw: line,
				timestamp: nil
			)
		}

		let message = object["message"] as? [String: Any]
		let timestamp = firstString(
			object["timestamp"],
			message?["timestamp"],
			object["date"],
			object["created_at"],
			object["ts"]
		)
		let id = firstString(object["id"], object["event_id"]) ?? "\(timestamp ?? "entry")-\(index)"
		let rendered = renderAwarenessObject(object)
		let detail = rendered.detail.isEmpty ? emptyDetail(for: object) : rendered.detail
		return CloudAwarenessEntry(
			id: id,
			title: rendered.title,
			detail: truncate(detail, max: 520),
			raw: line,
			timestamp: timestamp
		)
	}

	private static func renderAwarenessObject(_ object: [String: Any]) -> (title: String, detail: String) {
		guard let message = object["message"] as? [String: Any] else {
			return (awarenessTitle(object), extractText(object))
		}

		let role = firstString(message["role"], object["role"])?.lowercased() ?? "message"
		let blocks = contentBlocks(message["content"])
		let blockTypes = Set(blocks.compactMap { firstString($0["type"])?.lowercased() })
		let detail = blocks
			.map { contentBlockSummary($0) }
			.filter { !$0.isEmpty }
			.joined(separator: "\n")

		switch role {
		case "assistant":
			if blockTypes.contains("toolcall") {
				return (toolCallTitle(blocks), detail)
			}
			if blockTypes.contains("thinking") {
				return ("Thinking", detail)
			}
			return ("Assistant", detail)
		case "toolresult":
			let toolName = firstString(message["toolName"], message["tool_name"])
			return (toolName.map { "Tool result · \($0)" } ?? "Tool result", detail)
		case "toolcall":
			return (toolCallTitle(blocks), detail)
		case "user":
			return ("User", detail)
		case "system":
			return ("System", detail)
		default:
			return (role.replacingOccurrences(of: "_", with: " ").capitalized, detail)
		}
	}

	private static func emptyDetail(for object: [String: Any]) -> String {
		guard let message = object["message"] as? [String: Any] else {
			return compactJSON(object)
		}

		let role = firstString(message["role"], object["role"])?.lowercased() ?? "message"
		if role == "assistant" {
			if let stopReason = firstString(message["stopReason"], message["stop_reason"]) {
				return "Assistant turn completed with no visible text. Stop reason: \(stopReason)."
			}
			return "Assistant turn completed with no visible text."
		}
		if role == "toolresult" {
			return (message["isError"] as? Bool) == true ? "Tool returned an error with no visible output." : "(no output)"
		}
		if role == "toolcall" {
			return "Tool call recorded."
		}
		return "No visible text."
	}

	private static func awarenessTitle(_ object: [String: Any]) -> String {
		if let role = firstString(object["role"]) {
			return role.replacingOccurrences(of: "_", with: " ").capitalized
		}
		if let channel = firstString(object["channel"], object["channelId"], object["source"]) {
			return channel
		}
		if let type = firstString(object["type"]) {
			return type.replacingOccurrences(of: "_", with: " ").capitalized
		}
		return "Awareness"
	}

	private static func contentBlocks(_ value: Any?) -> [[String: Any]] {
		if let blocks = value as? [[String: Any]] {
			return blocks
		}
		if let block = value as? [String: Any] {
			return [block]
		}
		if let text = value as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			return [["type": "text", "text": text]]
		}
		return []
	}

	private static func contentBlockSummary(_ block: [String: Any]) -> String {
		let type = firstString(block["type"])?.lowercased() ?? "text"
		switch type {
		case "text":
			return firstString(block["text"], block["content"]) ?? extractText(block)
		case "thinking":
			let thinking = firstString(block["thinking"], block["text"], block["content"]) ?? extractText(block)
			return thinking.isEmpty ? "" : "Thinking: \(thinking)"
		case "toolcall":
			return toolCallDetail(block)
		case "image", "image_url", "input_image":
			return "Image attachment"
		default:
			let text = extractText(block)
			return text.isEmpty ? compactJSON(block) : text
		}
	}

	private static func toolCallTitle(_ blocks: [[String: Any]]) -> String {
		for block in blocks {
			guard firstString(block["type"])?.lowercased() == "toolcall" else { continue }
			if let name = firstString(block["name"], block["toolName"], block["tool_name"]) {
				return "Tool call · \(name)"
			}
		}
		return "Tool call"
	}

	private static func toolCallDetail(_ block: [String: Any]) -> String {
		let args = block["arguments"] as? [String: Any]
		if let label = firstString(block["label"], args?["label"], args?["description"], args?["task"]) {
			return label
		}

		for key in ["command", "cmd", "path", "target", "message", "text", "query", "url"] {
			if let value = firstString(args?[key], block[key]) {
				return value
			}
		}

		if let args, !args.isEmpty {
			return compactJSON(args)
		}
		if let name = firstString(block["name"], block["toolName"], block["tool_name"]) {
			return "Using \(name)"
		}
		return compactJSON(block)
	}

	private static func extractText(_ value: Any?) -> String {
		guard let value else { return "" }
		if let string = value as? String { return string }
		if let array = value as? [Any] {
			return array.map { extractText($0) }.filter { !$0.isEmpty }.joined(separator: "\n")
		}
		if let object = value as? [String: Any] {
			if let type = firstString(object["type"]), type.lowercased() == "toolcall" {
				return toolCallDetail(object)
			}
			for key in ["text", "thinking", "content", "message", "delta", "final_answer", "label", "output", "result"] {
				let text = extractText(object[key])
				if !text.isEmpty { return text }
			}
		}
		return ""
	}

	private static func compactJSON(_ value: Any) -> String {
		guard JSONSerialization.isValidJSONObject(value),
			  let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
			  let text = String(data: data, encoding: .utf8) else {
			return "\(value)"
		}
		return truncate(text, max: 360)
	}

	private static func firstString(_ values: Any?...) -> String? {
		for value in values {
			if let string = value as? String {
				let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
				if !trimmed.isEmpty { return trimmed }
			}
			if let number = value as? NSNumber {
				return number.stringValue
			}
		}
		return nil
	}

	private static func truncate(_ text: String, max: Int) -> String {
		let cleaned = text
			.replacingOccurrences(of: "\n\n\n+", with: "\n\n", options: .regularExpression)
			.trimmingCharacters(in: .whitespacesAndNewlines)
		guard cleaned.count > max else { return cleaned }
		let end = cleaned.index(cleaned.startIndex, offsetBy: max)
		return String(cleaned[..<end]) + "..."
	}
}

struct CloudAwarenessBacklog: Sendable, Equatable {
	let entries: [CloudAwarenessEntry]
	let total: Int
	let offset: Int
}

actor CloudAgentClient {
	let baseURL: URL
	private let clientID: String
	private let oauth: OAuthClient
	private let tokenStore: TokenStore
	private let session: URLSession

	init(
		baseURL: URL = URL(string: "https://crawdad.tinyfat.com")!,
		clientID: String,
		oauth: OAuthClient,
		tokenStore: TokenStore,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientID = clientID
		self.oauth = oauth
		self.tokenStore = tokenStore
		self.session = session
	}

	func currentBearerToken() async throws -> String {
		guard let tokens = tokenStore.load() else { throw CloudAPIError.notAuthenticated }
		if tokens.expiresAt > Date().addingTimeInterval(30) {
			return tokens.accessToken
		}
		guard let refresh = tokens.refreshToken else { throw CloudAPIError.notAuthenticated }
		let refreshed = try await oauth.refresh(refresh, clientID: clientID)
		try tokenStore.save(refreshed)
		return refreshed.accessToken
	}

	func listAgents() async throws -> [CloudAgent] {
		var req = URLRequest(url: baseURL.appendingPathComponent("api/v2/agents"))
		req.httpMethod = "GET"
		req.setValue("Bearer \(try await currentBearerToken())", forHTTPHeaderField: "Authorization")
		let (data, response) = try await session.data(for: req)
		try Self.assertOK(response, data)
		let decoder = JSONDecoder()
		decoder.keyDecodingStrategy = .convertFromSnakeCase
		return try decoder.decode(CloudAgentListResponse.self, from: data).agents
	}

	func awarenessBacklog(agentID: String, limit: Int = 40) async throws -> CloudAwarenessBacklog {
		var url = baseURL
			.appendingPathComponent("api")
			.appendingPathComponent("v2")
			.appendingPathComponent("agents")
			.appendingPathComponent(agentID)
			.appendingPathComponent("events")
		var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
		components?.queryItems = [
			URLQueryItem(name: "limit", value: String(limit)),
		]
		if let resolved = components?.url {
			url = resolved
		}

		var req = URLRequest(url: url)
		req.httpMethod = "GET"
		req.setValue("Bearer \(try await currentBearerToken())", forHTTPHeaderField: "Authorization")
		let (data, response) = try await session.data(for: req)
		try Self.assertOK(response, data)
		let decoded = try JSONDecoder().decode(CloudAwarenessResponse.self, from: data)
		let entries = decoded.lines.enumerated().map { index, line in
			CloudAwarenessEntry.parse(line, index: decoded.offset + index)
		}
		return CloudAwarenessBacklog(
			entries: entries,
			total: decoded.total,
			offset: decoded.offset
		)
	}

	private static func assertOK(_ response: URLResponse, _ data: Data) throws {
		guard let http = response as? HTTPURLResponse else { throw CloudAPIError.notHTTP }
		guard (200..<300).contains(http.statusCode) else {
			throw CloudAPIError.http(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
		}
	}
}

private struct CloudAgentListResponse: Decodable {
	let agents: [CloudAgent]
}

private struct CloudAwarenessResponse: Decodable {
	let lines: [String]
	let total: Int
	let offset: Int
}

enum CloudAPIError: Error, CustomStringConvertible {
	case notAuthenticated
	case notHTTP
	case http(status: Int, body: String)

	var description: String {
		switch self {
		case .notAuthenticated:
			return "Not authenticated."
		case .notHTTP:
			return "Response was not HTTP."
		case let .http(status, body):
			return "HTTP \(status): \(body)"
		}
	}
}
