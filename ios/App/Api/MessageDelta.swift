@preconcurrency import AVFoundation
import Foundation

@MainActor
final class SerializedSpeechCoordinator: NSObject, AVSpeechSynthesizerDelegate {
    var onSpeakingChanged: ((Bool) -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    private let ledger: SpeechIdentityLedger
    private var claimQueue: [SpeechCandidate] = []
    private var isClaiming = false
    private var queue: [SpeechCandidate] = []
    private var active: SpeechCandidate?
    private var generation = 0
    private let defaultsKey = "computer.mobile.spoken-completions.v1"

    override init() {
        let saved = UserDefaults.standard.stringArray(forKey: defaultsKey) ?? []
        self.ledger = SpeechIdentityLedger(spoken: saved)
        super.init()
        synthesizer.delegate = self
    }

    func enqueue(_ candidate: SpeechCandidate) {
        claimQueue.append(candidate)
        claimNextIfNeeded()
    }

    func stop() {
        generation += 1
        claimQueue.removeAll()
        isClaiming = false
        queue.removeAll()
        active = nil
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        onSpeakingChanged?(false)
    }

    private func claimNextIfNeeded() {
        guard !isClaiming, let candidate = claimQueue.first else { return }
        isClaiming = true
        let claimGeneration = generation
        Task { [weak self] in
            guard let self else { return }
            let claimed = await ledger.claim(candidate.completionID)
            let snapshot = await ledger.snapshot()
            UserDefaults.standard.set(snapshot, forKey: defaultsKey)
            guard claimGeneration == generation else { return }
            if claimQueue.first?.completionID == candidate.completionID {
                claimQueue.removeFirst()
            } else {
                claimQueue.removeAll { $0.completionID == candidate.completionID }
            }
            isClaiming = false
            if claimed {
                queue.append(candidate)
                speakNextIfNeeded()
            }
            claimNextIfNeeded()
        }
    }

    private func speakNextIfNeeded() {
        guard active == nil, !queue.isEmpty else { return }
        let candidate = queue.removeFirst()
        active = candidate
        let utterance = AVSpeechUtterance(string: candidate.text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-GB")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        onSpeakingChanged?(true)
        synthesizer.speak(utterance)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in finishCurrent() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in finishCurrent() }
    }

    private func finishCurrent() {
        active = nil
        if queue.isEmpty { onSpeakingChanged?(false) }
        speakNextIfNeeded()
    }
}
