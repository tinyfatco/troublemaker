import SwiftUI

struct ComputerOrb: View {
    let state: ComputerPresenceState
    var diameter: CGFloat = 72

    private var scale: CGFloat {
        switch state {
        case .listening: 1.08
        case .thinking: 0.94
        case .speaking: 1.04
        case .error: 0.9
        case .idle: 1
        }
    }

    private var opacity: Double { state == .error ? 0.65 : 1 }

    var body: some View {
        Circle()
            .fill(AngularGradient(
                colors: [.cyan, .blue, .purple, .pink, .orange, .yellow, .green, .cyan],
                center: .center
            ))
            .overlay {
                Circle()
                    .fill(RadialGradient(colors: [.white.opacity(0.74), .clear], center: .topLeading, startRadius: 0, endRadius: diameter * 0.72))
            }
            .overlay { Circle().stroke(.white, lineWidth: state == .listening ? 3 : 1) }
            .frame(width: diameter, height: diameter)
            .scaleEffect(scale)
            .opacity(opacity)
            .shadow(color: .white.opacity(state == .speaking ? 0.55 : 0.16), radius: state == .speaking ? 12 : 4)
            .animation(.spring(response: 0.28, dampingFraction: 0.72), value: state)
            .accessibilityLabel("Computer is (state.rawValue)")
    }
}

extension View {
    func computerBlock(background: Color, foreground: Color) -> some View {
        self
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(background)
            .foregroundStyle(foreground)
    }
}
