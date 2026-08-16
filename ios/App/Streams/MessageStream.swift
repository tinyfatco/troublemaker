import Foundation

extension TurnEvent {
    var acceptedDelivery: Bool {
        type == .delivery && (disposition == "accepted" || disposition == "duplicate")
    }
}
