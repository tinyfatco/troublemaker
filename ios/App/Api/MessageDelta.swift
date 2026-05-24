import Foundation

/// Parsed SSE event from `POST /api/v2/agents/:id/messages` response stream.
/// Mirrors processEvent() in troublemaker/ui/src/hooks/useWebChat.ts.
enum MessageDelta: Equatable {
    case status(String)              // "waking" | "connecting" | "container" | "worker" | "fallback" | "steering" | "streaming"
    case textDelta(String)           // streaming token of assistant text
    case thinkingDelta(String)       // streaming token of thinking
    case textFinal(String)           // complete text block at message_end — replaces accumulated text
    case thinkingFinal(String)
    case toolCall(id: String, name: String, args: String)
    case toolResult(id: String, output: String, isError: Bool)
    case error(String)
    case heartbeat
    case runComplete
    case unknown(type: String)

    static func parse(_ raw: String) -> MessageDelta? {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String
        else { return nil }

        switch type {
        case "status":
            return .status((obj["status"] as? String) ?? "")
        case "text_delta":
            return .textDelta((obj["delta"] as? String) ?? "")
        case "thinking_delta":
            return .thinkingDelta((obj["delta"] as? String) ?? "")
        case "text":
            return .textFinal((obj["text"] as? String) ?? "")
        case "thinking":
            return .thinkingFinal((obj["thinking"] as? String) ?? "")
        case "toolCall":
            let id = (obj["id"] as? String) ?? ""
            let name = (obj["name"] as? String) ?? "tool"
            let argsValue = obj["arguments"] ?? [:]
            let argsString: String
            if let d = try? JSONSerialization.data(withJSONObject: argsValue, options: [.sortedKeys]),
               let s = String(data: d, encoding: .utf8) {
                argsString = s
            } else {
                argsString = "\(argsValue)"
            }
            return .toolCall(id: id, name: name, args: argsString)
        case "toolResult":
            let id = (obj["toolCallId"] as? String) ?? ""
            let output: String
            let result = obj["result"] ?? ""
            if let s = result as? String { output = s }
            else if let d = try? JSONSerialization.data(withJSONObject: result), let s = String(data: d, encoding: .utf8) { output = s }
            else { output = "\(result)" }
            let isError = (obj["isError"] as? Bool) ?? false
            return .toolResult(id: id, output: output, isError: isError)
        case "error":
            return .error((obj["message"] as? String) ?? "Stream error")
        case "heartbeat":
            return .heartbeat
        case "run_complete":
            return .runComplete
        default:
            return .unknown(type: type)
        }
    }
}
