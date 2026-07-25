import Foundation

/// Mirrors troublemaker/ui/src/types.ts — the wire format for entries flowing
/// through the awareness feed (both backlog `GET /events` and the live SSE
/// `GET /events/stream`). Each JSONL line is one of these.

enum AwarenessRole: String, Decodable { case user, assistant, toolResult }

enum AwarenessBlock: Equatable {
    case text(String)
    case thinking(String)
    case toolCall(id: String, name: String, args: String)
    case toolResult(id: String, output: String, isError: Bool)
    case unknown
}

struct AwarenessLine: Equatable {
    enum Kind: Equatable { case session, message }
    let id: String
    let kind: Kind
    let timestamp: String
    let role: AwarenessRole?
    let blocks: [AwarenessBlock]
    /// User messages arrive prefixed `[ts] [channel] [user]: text`. Extracted
    /// for display so we don't show the metadata to the human.
    let channel: String?
    let userName: String?
    let strippedText: String?
}

enum AwarenessDecoder {
    /// Parse one JSONL line. Returns nil if the line is malformed or unrecognised.
    static func parse(_ line: String) -> AwarenessLine? {
        guard let data = line.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        let type = raw["type"] as? String
        let timestamp = raw["timestamp"] as? String ?? ""
        let id = raw["id"] as? String

        switch type {
        case "session":
            return AwarenessLine(
                id: id ?? "session-\(timestamp)",
                kind: .session,
                timestamp: timestamp,
                role: nil,
                blocks: [],
                channel: nil,
                userName: nil,
                strippedText: nil
            )

        case "message":
            guard let msg = raw["message"] as? [String: Any] else { return nil }
            let role = (msg["role"] as? String).flatMap(AwarenessRole.init(rawValue:))
            let blocks = (msg["content"] as? [[String: Any]]).map(parseBlocks) ?? []

            var channel: String?
            var userName: String?
            var stripped: String?
            if role == .user, let first = blocks.first(where: { if case .text = $0 { return true } else { return false } }),
               case .text(let text) = first {
                let cleaned = stripSessionContext(text)
                if let prefix = parseUserPrefix(cleaned) {
                    channel = prefix.channel
                    userName = prefix.userName
                    stripped = prefix.text
                } else if cleaned != text {
                    stripped = cleaned
                }
            }

            return AwarenessLine(
                id: id ?? "msg-\(timestamp)",
                kind: .message,
                timestamp: timestamp,
                role: role,
                blocks: blocks,
                channel: channel,
                userName: userName,
                strippedText: stripped
            )

        default:
            return nil
        }
    }

    private static func parseBlocks(_ items: [[String: Any]]) -> [AwarenessBlock] {
        items.compactMap(parseBlock)
    }

    private static func parseBlock(_ b: [String: Any]) -> AwarenessBlock? {
        switch b["type"] as? String {
        case "text":
            return .text((b["text"] as? String) ?? "")
        case "thinking":
            return .thinking((b["thinking"] as? String) ?? "")
        case "toolCall", "tool_call", "tool_use":
            let id = (b["id"] as? String) ?? (b["toolCallId"] as? String) ?? (b["tool_use_id"] as? String) ?? ""
            let name = (b["name"] as? String) ?? (b["toolName"] as? String) ?? "tool"
            let argsValue = b["arguments"] ?? b["args"] ?? b["input"] ?? [:]
            let argsString: String
            if let data = try? JSONSerialization.data(withJSONObject: argsValue, options: [.sortedKeys]) {
                argsString = String(data: data, encoding: .utf8) ?? ""
            } else {
                argsString = "\(argsValue)"
            }
            return .toolCall(id: id, name: name, args: argsString)
        case "toolResult", "tool_result":
            let id = (b["toolCallId"] as? String) ?? (b["tool_call_id"] as? String) ?? (b["tool_use_id"] as? String) ?? ""
            let result = b["result"] ?? b["content"] ?? b["output"] ?? ""
            let output: String
            if let str = result as? String { output = str }
            else if let data = try? JSONSerialization.data(withJSONObject: result), let str = String(data: data, encoding: .utf8) { output = str }
            else { output = "\(result)" }
            let isError = (b["isError"] as? Bool) ?? (b["is_error"] as? Bool) ?? false
            return .toolResult(id: id, output: output, isError: isError)
        default:
            return .unknown
        }
    }

    private static func stripSessionContext(_ s: String) -> String {
        // Mirrors the regex strip in types.ts: <session_context>...</session_context>.
        guard let regex = try? NSRegularExpression(pattern: "\\s*<session_context>[\\s\\S]*?</session_context>\\s*") else {
            return s
        }
        let range = NSRange(s.startIndex..., in: s)
        return regex
            .stringByReplacingMatches(in: s, range: range, withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func parseUserPrefix(_ s: String) -> (channel: String, userName: String, text: String)? {
        // [timestamp] [channel] [user]: text
        guard let regex = try? NSRegularExpression(pattern: "^\\[([^\\]]+)\\]\\s*\\[([^\\]]+)\\]\\s*\\[([^\\]]+)\\]:\\s*([\\s\\S]*)$") else {
            return nil
        }
        let range = NSRange(s.startIndex..., in: s)
        guard let match = regex.firstMatch(in: s, range: range), match.numberOfRanges == 5 else { return nil }
        func g(_ i: Int) -> String {
            guard let r = Range(match.range(at: i), in: s) else { return "" }
            return String(s[r])
        }
        return (channel: g(2), userName: g(3), text: g(4))
    }
}

extension AwarenessLine {
    /// Flatten all text/thinking content into a single string for the simple
    /// bubble renderer. Tool calls/results render as compact labels for now.
    var displayText: String {
        if let stripped = strippedText, !stripped.isEmpty { return stripped }
        var parts: [String] = []
        for block in blocks {
            switch block {
            case .text(let t): parts.append(t)
            case .thinking(let t): parts.append("[thinking] " + t)
            case .toolCall(_, let name, let args): parts.append("→ \(name) \(args)")
            case .toolResult(_, let output, let isError):
                let prefix = isError ? "⚠︎ " : "← "
                parts.append(prefix + output)
            case .unknown: break
            }
        }
        return parts.joined(separator: "\n")
    }
}
