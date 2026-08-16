import Foundation

enum ReconnectDelay {
    static func nanoseconds(for attempt: Int) -> UInt64 {
        let seconds = min(8, 1 << min(max(0, attempt), 3))
        return UInt64(seconds) * 1_000_000_000
    }
}
