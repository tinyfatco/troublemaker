import AVFoundation
import Foundation
import Security

enum VoiceProviderKind: String, CaseIterable, Identifiable {
	case localTroublemaker
	case openAIRealtime
	case deepgram

	var id: String { rawValue }

	var title: String {
		switch self {
		case .localTroublemaker: return "Troublemaker"
		case .openAIRealtime: return "Realtime 2"
		case .deepgram: return "Deepgram"
		}
	}

	var detail: String {
		switch self {
		case .localTroublemaker: return "Local socket"
		case .openAIRealtime: return "OpenAI voice"
		case .deepgram: return "STT to Zip"
		}
	}
}

enum RealtimeVoice: String, CaseIterable, Identifiable {
	case marin
	case cedar
	case alloy
	case ash
	case ballad
	case coral
	case echo
	case sage
	case shimmer
	case verse

	var id: String { rawValue }

	var title: String {
		rawValue.capitalized
	}

	var detail: String {
		switch self {
		case .marin, .cedar:
			return "Recommended"
		default:
			return "Built-in"
		}
	}
}

enum VoiceRuntimeState: Equatable {
	case idle
	case connecting
	case listening
	case transcribing
	case thinking
	case speaking
	case error

	var isActive: Bool {
		switch self {
		case .idle, .error: return false
		case .connecting, .listening, .transcribing, .thinking, .speaking: return true
		}
	}
}

enum VoiceAudioPayload {
	case encoded(Data)
	case pcm16(Data, sampleRate: Int)
}

struct VoiceProviderCallbacks {
	var state: (VoiceRuntimeState, String) -> Void
	var partialTranscript: (String) -> Void
	var finalTranscript: (String) -> Void
	var assistantTextDelta: (String) -> Void
	var assistantTextFinal: (String) -> Void
	var audio: (VoiceAudioPayload) -> Void
	var interruptAudio: () -> Void
	var bargeInAllowed: () -> Bool
	var error: (String) -> Void
}

protocol VoiceSessionProvider: AnyObject {
	var kind: VoiceProviderKind { get }
	var targetSampleRate: Double { get }
	var callbacks: VoiceProviderCallbacks? { get set }
	func connect() throws
	func sendAudio(_ pcm16: Data)
	func interrupt()
	func stop()
}

final class MacVoiceSession: NSObject, AVAudioPlayerDelegate {
	var onStateChange: ((VoiceRuntimeState, String) -> Void)?
	var onPartialTranscript: ((String) -> Void)?
	var onFinalTranscript: ((String) -> Void)?
	var onAssistantTextDelta: ((String) -> Void)?
	var onAssistantTextFinal: ((String) -> Void)?

	private let audioEngine = AVAudioEngine()
	private let playbackEngine = AVAudioEngine()
	private let playbackNode = AVAudioPlayerNode()
	private let lock = NSLock()
	private var provider: VoiceSessionProvider?
	private var state: VoiceRuntimeState = .idle
	private var player: AVAudioPlayer?
	private var playbackNodeAttached = false
	private var playbackFormat: AVAudioFormat?
	private var scheduledPCMBufferCount = 0
	private var pendingAudio = Data()
	private var pendingAudioFormat: VoiceAudioPayload?
	private var micSuppressed = false
	private var realtimeMicGate = RealtimeMicSuppressionGate()
	private var pendingRealtimeListeningRelease = false
	private var realtimePlayedAudioInResponse = false
	private var realtimeMicReleaseWorkItem: DispatchWorkItem?

	func start(
		kind: VoiceProviderKind,
		localVoicePort: Int = 8766,
		runtimePort: Int = 3017,
		agentName: String,
		realtimeVoice: RealtimeVoice = .marin
	) async {
		stop()
		setState(.connecting, "Connecting \(kind.title)...")

		guard await requestMicrophoneAccess() else {
			setState(.error, "Microphone access denied.")
			return
		}

		do {
			let provider = try makeProvider(
				kind: kind,
				localVoicePort: localVoicePort,
				runtimePort: runtimePort,
				agentName: agentName,
				realtimeVoice: realtimeVoice
			)
			provider.callbacks = callbacks()
			self.provider = provider
			try provider.connect()
			try startCapture(targetSampleRate: provider.targetSampleRate)
		} catch {
			stopCapture()
			self.provider = nil
			setState(.error, String(describing: error))
		}
	}

	func stop() {
		provider?.stop()
		provider = nil
		stopCapture()
		player?.stop()
		player = nil
		playbackNode.stop()
		playbackEngine.stop()
		realtimeMicReleaseWorkItem?.cancel()
		lock.withLock {
			scheduledPCMBufferCount = 0
			pendingAudio.removeAll()
			pendingAudioFormat = nil
			micSuppressed = false
			realtimeMicGate.reset()
			pendingRealtimeListeningRelease = false
			realtimePlayedAudioInResponse = false
			realtimeMicReleaseWorkItem = nil
		}
		setState(.idle, "Voice stopped.")
	}

	func interrupt() {
		guard let provider else { return }
		provider.interrupt()
		if provider.kind != .openAIRealtime {
			interruptPlaybackForBargeIn()
			setState(.listening, "Interrupted; listening...")
		}
	}

	func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
		lock.withLock { micSuppressed = false }
		setState(.listening, "Listening...")
	}

	private func callbacks() -> VoiceProviderCallbacks {
		VoiceProviderCallbacks(
			state: { [weak self] state, message in self?.setState(state, message) },
			partialTranscript: { [weak self] text in self?.emitPartial(text) },
			finalTranscript: { [weak self] text in self?.emitFinalTranscript(text) },
			assistantTextDelta: { [weak self] text in self?.emitAssistantDelta(text) },
			assistantTextFinal: { [weak self] text in self?.emitAssistantFinal(text) },
			audio: { [weak self] payload in self?.handleAudio(payload) },
			interruptAudio: { [weak self] in self?.interruptPlaybackForBargeIn() },
			bargeInAllowed: { [weak self] in self?.isRealtimeBargeInAllowed() ?? true },
			error: { [weak self] message in self?.setState(.error, message) }
		)
	}

	private func makeProvider(
		kind: VoiceProviderKind,
		localVoicePort: Int,
		runtimePort: Int,
		agentName: String,
		realtimeVoice: RealtimeVoice
	) throws -> VoiceSessionProvider {
		switch kind {
		case .localTroublemaker:
			return LocalTroublemakerVoiceProvider(port: localVoicePort)
		case .openAIRealtime:
			let apiKey = try VoiceSecretStore.firstValue(accounts: ["OPENAI_API_KEY", "MOM_OPENAI_API_KEY"])
			return OpenAIRealtimeVoiceProvider(apiKey: apiKey, agentName: agentName, runtimePort: runtimePort, voice: realtimeVoice)
		case .deepgram:
			let apiKey = try VoiceSecretStore.firstValue(accounts: ["DEEPGRAM_API_KEY", "MOM_DEEPGRAM_API_KEY"])
			return DeepgramSTTVoiceProvider(apiKey: apiKey)
		}
	}

	private func requestMicrophoneAccess() async -> Bool {
		switch AVCaptureDevice.authorizationStatus(for: .audio) {
		case .authorized:
			return true
		case .denied, .restricted:
			return false
		case .notDetermined:
			return await withCheckedContinuation { continuation in
				AVCaptureDevice.requestAccess(for: .audio) { granted in
					continuation.resume(returning: granted)
				}
			}
		@unknown default:
			return false
		}
	}

	private func startCapture(targetSampleRate: Double) throws {
		stopCapture()
		let input = audioEngine.inputNode
		let format = input.inputFormat(forBus: 0)
		input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
			guard let self else { return }
			let suppressed = self.lock.withLock { self.micSuppressed }
			guard !suppressed, let data = Self.pcm16Data(from: buffer, targetSampleRate: targetSampleRate) else { return }
			self.provider?.sendAudio(data)
		}
		audioEngine.prepare()
		try audioEngine.start()
	}

	private func stopCapture() {
		if audioEngine.isRunning {
			audioEngine.stop()
		}
		audioEngine.inputNode.removeTap(onBus: 0)
	}

	private func handleAudio(_ payload: VoiceAudioPayload) {
		if case let .pcm16(data, sampleRate) = payload {
			playPCM16(data, sampleRate: sampleRate)
			return
		}

		lock.withLock {
			micSuppressed = true
			if case .encoded(let data) = payload {
				if case .encoded? = pendingAudioFormat {
					pendingAudio.append(data)
				} else {
					pendingAudio = data
					pendingAudioFormat = payload
				}
			}
		}
		setState(.speaking, "Speaking...")
	}

	private func playPCM16(_ data: Data, sampleRate: Int) {
		guard let buffer = Self.pcmFloatBuffer(pcm16: data, sampleRate: sampleRate) else { return }
		do {
			try ensurePlaybackEngine(sampleRate: sampleRate)
			let isRealtime = provider?.kind == .openAIRealtime
			let suppressMic = !isRealtime
			let shouldArmRealtime = isRealtime && lock.withLock { !realtimeMicGate.guardActive }
			if shouldArmRealtime {
				suppressRealtimeMicDuringPlayback()
			}
			lock.withLock {
				if suppressMic {
					micSuppressed = true
				} else {
					realtimePlayedAudioInResponse = true
				}
				scheduledPCMBufferCount += 1
			}
			playbackNode.scheduleBuffer(buffer) { [weak self] in
				self?.completeScheduledPCMBuffer(releaseMic: suppressMic)
			}
			if !playbackNode.isPlaying {
				playbackNode.play()
			}
			setState(.speaking, "Speaking...")
		} catch {
			lock.withLock { micSuppressed = false }
			setState(.error, "Audio playback failed: \(error.localizedDescription)")
		}
	}

	private func ensurePlaybackEngine(sampleRate: Int) throws {
		let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: 1)!
		if !playbackNodeAttached {
			playbackEngine.attach(playbackNode)
			playbackNodeAttached = true
		}
		if playbackFormat?.sampleRate != format.sampleRate || playbackFormat?.channelCount != format.channelCount {
			playbackNode.stop()
			playbackEngine.disconnectNodeOutput(playbackNode)
			playbackEngine.connect(playbackNode, to: playbackEngine.mainMixerNode, format: format)
			playbackFormat = format
		}
		if !playbackEngine.isRunning {
			try playbackEngine.start()
		}
	}

	private func completeScheduledPCMBuffer(releaseMic: Bool) {
		var shouldReleaseRealtimeAfterDrain = false
		lock.withLock {
			scheduledPCMBufferCount = max(0, scheduledPCMBufferCount - 1)
			if releaseMic && scheduledPCMBufferCount == 0 {
				micSuppressed = false
			}
			if !releaseMic && scheduledPCMBufferCount == 0 && pendingRealtimeListeningRelease {
				shouldReleaseRealtimeAfterDrain = true
			}
		}
		if shouldReleaseRealtimeAfterDrain {
			scheduleRealtimeMicReleaseAfterPlaybackDrain()
		}
	}

	private func interruptPlaybackForBargeIn() {
		player?.stop()
		player = nil
		playbackNode.stop()
		realtimeMicReleaseWorkItem?.cancel()
		lock.withLock {
			scheduledPCMBufferCount = 0
			pendingAudio.removeAll()
			pendingAudioFormat = nil
			micSuppressed = false
			realtimeMicGate.reset()
			pendingRealtimeListeningRelease = false
			realtimePlayedAudioInResponse = false
			realtimeMicReleaseWorkItem = nil
		}
		setState(.transcribing, "Interrupted; listening...")
	}

	private func suppressRealtimeMicDuringPlayback() {
		lock.withLock {
			realtimeMicGate.arm(armedAt: .distantFuture)
			micSuppressed = realtimeMicGate.micSuppressed
		}
	}

	private func isRealtimeBargeInAllowed() -> Bool {
		lock.withLock {
			realtimeMicGate.isBargeInAllowed(now: Date())
		}
	}

	@discardableResult
	private func flushAudioIfNeeded() -> Bool {
		let payload: VoiceAudioPayload? = lock.withLock {
			guard !pendingAudio.isEmpty, let format = pendingAudioFormat else { return nil }
			let data = pendingAudio
			pendingAudio.removeAll()
			pendingAudioFormat = nil
			switch format {
			case .encoded:
				return .encoded(data)
			case .pcm16(_, let sampleRate):
				return .pcm16(data, sampleRate: sampleRate)
			}
		}
		guard let payload else { return false }

		do {
			let data: Data
			switch payload {
			case .encoded(let encoded):
				data = encoded
			case .pcm16(let pcm, let sampleRate):
				data = Self.wavData(pcm16: pcm, sampleRate: sampleRate)
			}
			let player = try AVAudioPlayer(data: data)
			self.player = player
			player.delegate = self
			player.prepareToPlay()
			return player.play()
		} catch {
			lock.withLock { micSuppressed = false }
			setState(.listening, "Listening...")
			return false
		}
	}

	private func scheduleRealtimeMicReleaseAfterPlaybackDrain() {
		realtimeMicReleaseWorkItem?.cancel()
		let releaseAt = Date().addingTimeInterval(OpenAIRealtimeSessionConfig.playbackDrainHoldSeconds)
		let workItem = DispatchWorkItem { [weak self] in
			self?.releaseRealtimeMicAfterPlaybackDrain()
		}
		lock.withLock {
			realtimeMicGate.holdAfterPlayback(until: releaseAt)
			micSuppressed = realtimeMicGate.micSuppressed
			realtimeMicReleaseWorkItem = workItem
		}
		DispatchQueue.main.asyncAfter(deadline: .now() + OpenAIRealtimeSessionConfig.playbackDrainHoldSeconds, execute: workItem)
	}

	private func releaseRealtimeMicAfterPlaybackDrain() {
		var shouldNotify = false
		lock.withLock {
			guard pendingRealtimeListeningRelease, scheduledPCMBufferCount == 0 else { return }
			pendingRealtimeListeningRelease = false
			realtimePlayedAudioInResponse = false
			realtimeMicReleaseWorkItem = nil
			realtimeMicGate.releaseForListening()
			micSuppressed = realtimeMicGate.micSuppressed
			state = .listening
			shouldNotify = true
		}
		if shouldNotify {
			DispatchQueue.main.async { [weak self] in
				self?.onStateChange?(.listening, "Listening with Realtime 2...")
			}
		}
	}

	private func emitPartial(_ text: String) {
		DispatchQueue.main.async { [weak self] in self?.onPartialTranscript?(text) }
	}

	private func emitFinalTranscript(_ text: String) {
		DispatchQueue.main.async { [weak self] in self?.onFinalTranscript?(text) }
	}

	private func emitAssistantDelta(_ text: String) {
		DispatchQueue.main.async { [weak self] in self?.onAssistantTextDelta?(text) }
	}

	private func emitAssistantFinal(_ text: String) {
		DispatchQueue.main.async { [weak self] in self?.onAssistantTextFinal?(text) }
	}

	private func setState(_ newState: VoiceRuntimeState, _ message: String) {
		if provider?.kind == .openAIRealtime {
			if newState == .speaking {
				realtimeMicReleaseWorkItem?.cancel()
				lock.withLock {
					realtimeMicReleaseWorkItem = nil
					pendingRealtimeListeningRelease = false
					realtimeMicGate.arm(armedAt: .distantFuture)
					micSuppressed = realtimeMicGate.micSuppressed
					state = newState
				}
				DispatchQueue.main.async { [weak self] in
					self?.onStateChange?(newState, message)
				}
				return
			}

			if newState == .listening {
				var shouldDeferRelease = false
				var shouldScheduleRelease = false
				lock.withLock {
					if scheduledPCMBufferCount > 0 {
						pendingRealtimeListeningRelease = true
						state = .speaking
						shouldDeferRelease = true
					} else if realtimePlayedAudioInResponse {
						pendingRealtimeListeningRelease = true
						state = .speaking
						shouldDeferRelease = true
						shouldScheduleRelease = true
					} else {
						realtimeMicReleaseWorkItem?.cancel()
						realtimeMicReleaseWorkItem = nil
						pendingRealtimeListeningRelease = false
						realtimeMicGate.releaseForListening()
						micSuppressed = realtimeMicGate.micSuppressed
						state = .listening
					}
				}
				if shouldScheduleRelease {
					scheduleRealtimeMicReleaseAfterPlaybackDrain()
				}
				if shouldDeferRelease {
					DispatchQueue.main.async { [weak self] in
						self?.onStateChange?(.speaking, "Finishing Realtime audio...")
					}
					return
				}
				DispatchQueue.main.async { [weak self] in
					self?.onStateChange?(newState, message)
				}
				return
			}
		}

		if newState == .listening, flushAudioIfNeeded() {
			lock.withLock { state = .speaking }
			DispatchQueue.main.async { [weak self] in
				self?.onStateChange?(.speaking, "Speaking...")
			}
			return
		}

		lock.withLock {
			state = newState
			if newState == .listening {
				micSuppressed = false
			}
			if newState == .idle || newState == .error {
				realtimeMicReleaseWorkItem?.cancel()
				realtimeMicReleaseWorkItem = nil
				realtimeMicGate.reset()
				micSuppressed = realtimeMicGate.micSuppressed
				pendingRealtimeListeningRelease = false
				realtimePlayedAudioInResponse = false
			}
		}
		DispatchQueue.main.async { [weak self] in
			self?.onStateChange?(newState, message)
		}
	}

	private static func pcm16Data(from buffer: AVAudioPCMBuffer, targetSampleRate: Double) -> Data? {
		guard let channel = buffer.floatChannelData?[0] else { return nil }
		let frameCount = Int(buffer.frameLength)
		guard frameCount > 0 else { return nil }
		let sourceRate = buffer.format.sampleRate
		let source = UnsafeBufferPointer(start: channel, count: frameCount)
		let outputCount = max(1, Int(Double(frameCount) * targetSampleRate / sourceRate))
		var data = Data(count: outputCount * MemoryLayout<Int16>.size)
		data.withUnsafeMutableBytes { rawBuffer in
			let out = rawBuffer.bindMemory(to: Int16.self)
			for i in 0..<outputCount {
				let sourceIndex = min(frameCount - 1, Int(Double(i) * sourceRate / targetSampleRate))
				let clamped = max(-1.0, min(1.0, source[sourceIndex]))
				let value = clamped < 0 ? clamped * Float(Int(Int16.max) + 1) : clamped * Float(Int16.max)
				out[i] = Int16(value).littleEndian
			}
		}
		return data
	}

	private static func wavData(pcm16: Data, sampleRate: Int) -> Data {
		var data = Data()
		let byteRate = UInt32(sampleRate * 2)
		let blockAlign = UInt16(2)
		let subchunk2Size = UInt32(pcm16.count)
		let chunkSize = UInt32(36 + pcm16.count)
		data.appendASCII("RIFF")
		data.appendLE(chunkSize)
		data.appendASCII("WAVE")
		data.appendASCII("fmt ")
		data.appendLE(UInt32(16))
		data.appendLE(UInt16(1))
		data.appendLE(UInt16(1))
		data.appendLE(UInt32(sampleRate))
		data.appendLE(byteRate)
		data.appendLE(blockAlign)
		data.appendLE(UInt16(16))
		data.appendASCII("data")
		data.appendLE(subchunk2Size)
		data.append(pcm16)
		return data
	}

	private static func pcmFloatBuffer(pcm16: Data, sampleRate: Int) -> AVAudioPCMBuffer? {
		let frameCount = pcm16.count / MemoryLayout<Int16>.size
		guard frameCount > 0,
			  let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: 1),
			  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)),
			  let channel = buffer.floatChannelData?[0] else {
			return nil
		}
		buffer.frameLength = AVAudioFrameCount(frameCount)
		pcm16.withUnsafeBytes { rawBuffer in
			let bytes = rawBuffer.bindMemory(to: UInt8.self)
			for frame in 0..<frameCount {
				let offset = frame * 2
				let raw = UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
				let sample = Int16(bitPattern: raw)
				if sample < 0 {
					channel[frame] = Float(sample) / 32768.0
				} else {
					channel[frame] = Float(sample) / 32767.0
				}
			}
		}
		return buffer
	}
}

private final class LocalTroublemakerVoiceProvider: VoiceSessionProvider {
	let kind: VoiceProviderKind = .localTroublemaker
	let targetSampleRate: Double = 16_000
	var callbacks: VoiceProviderCallbacks?

	private let port: Int
	private let session: URLSession
	private var task: URLSessionWebSocketTask?

	init(port: Int) {
		self.port = port
		session = URLSession(configuration: .default)
	}

	func connect() throws {
		let url = URL(string: "ws://127.0.0.1:\(port)")!
		let task = session.webSocketTask(with: url)
		self.task = task
		task.resume()
		callbacks?.state(.listening, "Listening through Troublemaker...")
		receive()
	}

	func sendAudio(_ pcm16: Data) {
		task?.send(.data(pcm16)) { [weak self] error in
			if let error { self?.callbacks?.error("Voice socket send failed: \(error.localizedDescription)") }
		}
	}

	func interrupt() {
		task?.send(.string("{\"type\":\"stop\"}")) { _ in }
	}

	func stop() {
		task?.send(.string("{\"type\":\"stop\"}")) { _ in }
		task?.cancel(with: .normalClosure, reason: nil)
		task = nil
	}

	private func receive() {
		task?.receive { [weak self] result in
			guard let self else { return }
			switch result {
			case .success(let message):
				self.handle(message)
				self.receive()
			case .failure(let error):
				self.callbacks?.error("Voice socket closed: \(error.localizedDescription)")
			}
		}
	}

	private func handle(_ message: URLSessionWebSocketTask.Message) {
		switch message {
		case .data(let data):
			callbacks?.audio(.encoded(data))
		case .string(let text):
			guard let event = VoiceJSON.object(text) else { return }
			switch event.string("type") {
			case "listening":
				callbacks?.state(.listening, "Listening...")
			case "thinking":
				callbacks?.state(.thinking, "Zip is thinking...")
			case "speaking":
				callbacks?.state(.speaking, "Speaking...")
			case "partial":
				callbacks?.partialTranscript(event.string("text") ?? "")
			case "transcript":
				callbacks?.finalTranscript(event.string("text") ?? "")
			case "assistant_text":
				callbacks?.assistantTextFinal(event.string("text") ?? "")
			case "error":
				callbacks?.error(event.string("message") ?? "Voice socket error")
			default:
				break
			}
		@unknown default:
			break
		}
	}
}

private final class DeepgramSTTVoiceProvider: VoiceSessionProvider {
	let kind: VoiceProviderKind = .deepgram
	let targetSampleRate: Double = 16_000
	var callbacks: VoiceProviderCallbacks?

	private let apiKey: String
	private let session: URLSession
	private var task: URLSessionWebSocketTask?
	private var finalSegments: [String] = []

	init(apiKey: String) {
		self.apiKey = apiKey
		session = URLSession(configuration: .default)
	}

	func connect() throws {
		var components = URLComponents(string: "wss://api.deepgram.com/v1/listen")!
		components.queryItems = [
			URLQueryItem(name: "model", value: "nova-3"),
			URLQueryItem(name: "encoding", value: "linear16"),
			URLQueryItem(name: "sample_rate", value: "16000"),
			URLQueryItem(name: "channels", value: "1"),
			URLQueryItem(name: "interim_results", value: "true"),
			URLQueryItem(name: "smart_format", value: "true"),
			URLQueryItem(name: "endpointing", value: "450"),
			URLQueryItem(name: "vad_events", value: "true"),
			URLQueryItem(name: "utterance_end_ms", value: "1000"),
		]
		var request = URLRequest(url: components.url!)
		request.setValue("Token \(apiKey)", forHTTPHeaderField: "Authorization")
		let task = session.webSocketTask(with: request)
		self.task = task
		task.resume()
		callbacks?.state(.listening, "Listening with Deepgram...")
		receive()
	}

	func sendAudio(_ pcm16: Data) {
		task?.send(.data(pcm16)) { [weak self] error in
			if let error { self?.callbacks?.error("Deepgram send failed: \(error.localizedDescription)") }
		}
	}

	func interrupt() {
		finalSegments.removeAll()
		callbacks?.state(.listening, "Listening with Deepgram...")
	}

	func stop() {
		task?.cancel(with: .normalClosure, reason: nil)
		task = nil
		finalSegments.removeAll()
	}

	private func receive() {
		task?.receive { [weak self] result in
			guard let self else { return }
			switch result {
			case .success(let message):
				self.handle(message)
				self.receive()
			case .failure(let error):
				self.callbacks?.error("Deepgram closed: \(error.localizedDescription)")
			}
		}
	}

	private func handle(_ message: URLSessionWebSocketTask.Message) {
		guard case .string(let text) = message, let event = VoiceJSON.object(text) else { return }
		let type = event.string("type")
		if type == "SpeechStarted" {
			callbacks?.state(.transcribing, "Speech detected...")
			return
		}
		if type == "UtteranceEnd" {
			flushFinalSegments()
			return
		}

		guard let channel = event.dictionary("channel"),
			  let alternatives = channel["alternatives"] as? [[String: Any]],
			  let transcript = (alternatives.first?["transcript"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
			  !transcript.isEmpty else {
			return
		}

		let isFinal = event.bool("is_final")
		let speechFinal = event.bool("speech_final")
		if isFinal {
			finalSegments.append(transcript)
			if speechFinal {
				flushFinalSegments()
			}
		} else {
			callbacks?.partialTranscript(transcript)
		}
	}

	private func flushFinalSegments() {
		let text = finalSegments.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
		finalSegments.removeAll()
		guard !text.isEmpty else { return }
		callbacks?.finalTranscript(text)
		callbacks?.state(.thinking, "Sending to Zip...")
	}
}

private final class OpenAIRealtimeVoiceProvider: VoiceSessionProvider {
	let kind: VoiceProviderKind = .openAIRealtime
	let targetSampleRate: Double = 24_000
	var callbacks: VoiceProviderCallbacks?

	private let apiKey: String
	private let agentName: String
	private let runtimePort: Int
	private let voice: RealtimeVoice
	private let session: URLSession
	private var task: URLSessionWebSocketTask?
	private var didSendSessionUpdate = false
	private var handledFunctionCallIDs = Set<String>()
	private var responseActive = false
	private var responseCancelSent = false
	private var responseCreatePendingAfterCancel = false
	private var bargeInCandidateItemIDs = Set<String>()
	private var ignoredInputItemIDs = Set<String>()
	private var respondedInputItemIDs = Set<String>()
	private var currentAssistantTranscript = ""
	private var recentAssistantTranscript = ""
	private var lastAssistantResponseEndedAt: Date?

	init(apiKey: String, agentName: String, runtimePort: Int, voice: RealtimeVoice) {
		self.apiKey = apiKey
		self.agentName = agentName
		self.runtimePort = runtimePort
		self.voice = voice
		session = URLSession(configuration: .default)
	}

	func connect() throws {
		var request = URLRequest(url: URL(string: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2")!)
		request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
		let task = session.webSocketTask(with: request)
		self.task = task
		task.resume()
		callbacks?.state(.connecting, "Connecting Realtime 2...")
		receive()
	}

	func sendAudio(_ pcm16: Data) {
		let event: [String: Any] = [
			"type": "input_audio_buffer.append",
			"audio": pcm16.base64EncodedString(),
		]
		sendJSON(event)
	}

	func interrupt() {
		sendJSON(["type": "input_audio_buffer.clear"])
		if responseActive {
			responseCreatePendingAfterCancel = false
			cancelActiveResponseForBargeIn()
		} else {
			callbacks?.interruptAudio()
			callbacks?.state(.listening, "Listening with Realtime 2...")
		}
	}

	func stop() {
		task?.cancel(with: .normalClosure, reason: nil)
		task = nil
		didSendSessionUpdate = false
		handledFunctionCallIDs.removeAll()
		responseActive = false
		responseCancelSent = false
		responseCreatePendingAfterCancel = false
		bargeInCandidateItemIDs.removeAll()
		ignoredInputItemIDs.removeAll()
		respondedInputItemIDs.removeAll()
		currentAssistantTranscript = ""
		recentAssistantTranscript = ""
		lastAssistantResponseEndedAt = nil
	}

	private func sendSessionUpdate() {
		let instructions = """
		You are \(agentName), the Troublemaker realtime voice agent running on this Mac. The user is speaking directly to you.
		Answer the user's request; do not repeat, read back, or transcribe their words unless they explicitly ask you to.
		You have tools for reading/editing/writing files, running bash commands, inspecting channels and Slack threads, and sending user-visible messages through Troublemaker.
		Use get_context_briefing for cheap Zip orientation and search_context for specific past-chat lookup. Do not load full awareness/context files unless the user explicitly needs raw records.
		Use other tools when files, actions, or channel/thread routing are needed. Do not claim you lack Zip/Troublemaker context before checking the relevant tools.
		Keep spoken responses concise and natural. When a tool result is long, summarize the useful outcome.
		"""
		sendJSON([
			"type": "session.update",
			"session": [
				"type": "realtime",
				"model": "gpt-realtime-2",
				"output_modalities": ["audio"],
				"instructions": instructions,
				"reasoning": ["effort": "low"],
				"tools": Self.realtimeTools(),
				"tool_choice": "auto",
				"parallel_tool_calls": false,
				"audio": OpenAIRealtimeSessionConfig.audioConfig(voiceName: voice.rawValue),
			],
		])
	}

	private func receive() {
		task?.receive { [weak self] result in
			guard let self else { return }
			switch result {
			case .success(let message):
				self.handle(message)
				self.receive()
			case .failure(let error):
				self.callbacks?.error("Realtime closed: \(error.localizedDescription)")
			}
		}
	}

	private func handle(_ message: URLSessionWebSocketTask.Message) {
		guard case .string(let text) = message, let event = VoiceJSON.object(text) else { return }
		switch event.string("type") {
		case "session.created":
			if !didSendSessionUpdate {
				didSendSessionUpdate = true
				sendSessionUpdate()
				callbacks?.state(.connecting, "Configuring Realtime 2...")
			}
		case "session.updated":
			callbacks?.state(.listening, "Realtime 2 ready.")
		case "response.created":
			responseActive = true
			responseCancelSent = false
			currentAssistantTranscript = ""
		case "input_audio_buffer.speech_started":
			let itemID = event.string("item_id")
			if responseActive {
				if let itemID {
					bargeInCandidateItemIDs.insert(itemID)
				}
				if callbacks?.bargeInAllowed() == true {
					callbacks?.state(.transcribing, "Barge-in detected...")
				}
			} else {
				callbacks?.state(.transcribing, "Speech detected...")
			}
		case "input_audio_buffer.speech_stopped", "input_audio_buffer.committed":
			if !responseActive {
				callbacks?.state(.thinking, "Realtime 2 is thinking...")
			}
		case "conversation.item.input_audio_transcription.delta":
			let itemID = event.string("item_id")
			if !shouldHoldTranscriptForBargeIn(itemID: itemID) {
				callbacks?.partialTranscript(event.string("delta") ?? "")
			}
		case "conversation.item.input_audio_transcription.completed":
			handleInputTranscriptionCompleted(event)
		case "conversation.item.input_audio_transcription.failed":
			handleInputTranscriptionFailed(event)
		case "response.output_text.delta", "response.audio_transcript.delta", "response.output_audio_transcript.delta":
			responseActive = true
			let delta = event.string("delta") ?? ""
			currentAssistantTranscript += delta
			callbacks?.assistantTextDelta(delta)
			callbacks?.state(.speaking, "Realtime 2 is speaking...")
		case "response.output_text.done", "response.output_audio_transcript.done":
			let final = event.string("text") ?? event.string("transcript") ?? ""
			if !final.isEmpty {
				currentAssistantTranscript = final
			}
			callbacks?.assistantTextFinal(final)
		case "response.output_audio.delta", "response.audio.delta":
			responseActive = true
			if let delta = event.string("delta"), let data = Data(base64Encoded: delta) {
				callbacks?.audio(.pcm16(data, sampleRate: 24000))
			}
		case "response.output_item.done":
			if let item = event.dictionary("item"), item.string("type") == "function_call" {
				handleFunctionCall(item)
			}
		case "response.output_audio.done", "response.audio.done", "response.done":
			if let response = event.dictionary("response"),
			   let output = response["output"] as? [[String: Any]] {
				for item in output where item.string("type") == "function_call" {
					handleFunctionCall(item)
				}
			}
			responseActive = false
			responseCancelSent = false
			rememberAssistantTranscript()
			if responseCreatePendingAfterCancel {
				responseCreatePendingAfterCancel = false
				sendResponseCreate()
			} else {
				callbacks?.state(.listening, "Listening with Realtime 2...")
			}
		case "error":
			if let error = event.dictionary("error") {
				callbacks?.error((error["message"] as? String) ?? "Realtime error")
			} else {
				callbacks?.error(event.string("message") ?? "Realtime error")
			}
		default:
			break
		}
	}

	private func cancelActiveResponseForBargeIn() {
		guard responseActive, !responseCancelSent else { return }
		responseCancelSent = true
		callbacks?.interruptAudio()
		sendJSON(["type": "response.cancel"])
	}

	private func sendResponseCreate() {
		callbacks?.state(.thinking, "Realtime 2 is thinking...")
		sendJSON(["type": "response.create"])
	}

	private func handleInputTranscriptionCompleted(_ event: [String: Any]) {
		let transcript = (event.string("transcript") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		let itemID = event.string("item_id")
		if let itemID, respondedInputItemIDs.contains(itemID) {
			return
		}
		guard !transcript.isEmpty else {
			discardInputItem(itemID)
			return
		}

		if shouldSuppressAsAssistantEcho(transcript, itemID: itemID) {
			discardInputItem(itemID)
			callbacks?.state(responseActive ? .speaking : .listening, responseActive ? "Realtime 2 is speaking..." : "Listening with Realtime 2...")
			return
		}

		callbacks?.finalTranscript(transcript)
		if let itemID {
			respondedInputItemIDs.insert(itemID)
			bargeInCandidateItemIDs.remove(itemID)
		}

		if responseActive {
			responseCreatePendingAfterCancel = true
			cancelActiveResponseForBargeIn()
		} else {
			sendResponseCreate()
		}
	}

	private func handleInputTranscriptionFailed(_ event: [String: Any]) {
		let itemID = event.string("item_id")
		if shouldHoldTranscriptForBargeIn(itemID: itemID) {
			discardInputItem(itemID)
			return
		}
		if let itemID, respondedInputItemIDs.contains(itemID) {
			return
		}
		sendResponseCreate()
	}

	private func shouldHoldTranscriptForBargeIn(itemID: String?) -> Bool {
		guard let itemID else { return responseActive }
		return responseActive || bargeInCandidateItemIDs.contains(itemID)
	}

	private func shouldSuppressAsAssistantEcho(_ transcript: String, itemID: String?) -> Bool {
		let candidateDuringAssistant = shouldHoldTranscriptForBargeIn(itemID: itemID) || didRecentlyFinishAssistantResponse()
		guard candidateDuringAssistant else { return false }
		if callbacks?.bargeInAllowed() == false {
			return true
		}
		let assistantText = [currentAssistantTranscript, recentAssistantTranscript]
			.joined(separator: " ")
			.trimmingCharacters(in: .whitespacesAndNewlines)
		return Self.transcriptLooksLikeEcho(transcript, assistantText: assistantText)
	}

	private func didRecentlyFinishAssistantResponse() -> Bool {
		guard let lastAssistantResponseEndedAt else { return false }
		return Date().timeIntervalSince(lastAssistantResponseEndedAt) < 2.5
	}

	private func discardInputItem(_ itemID: String?) {
		guard let itemID, !ignoredInputItemIDs.contains(itemID) else { return }
		ignoredInputItemIDs.insert(itemID)
		bargeInCandidateItemIDs.remove(itemID)
		sendJSON([
			"type": "conversation.item.delete",
			"item_id": itemID,
		])
	}

	private func rememberAssistantTranscript() {
		let cleaned = currentAssistantTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
		if !cleaned.isEmpty {
			recentAssistantTranscript = cleaned
			lastAssistantResponseEndedAt = Date()
		}
		currentAssistantTranscript = ""
	}

	private func handleFunctionCall(_ item: [String: Any]) {
		guard let callID = item.string("call_id"),
			  let name = item.string("name"),
			  !handledFunctionCallIDs.contains(callID) else {
			return
		}
		handledFunctionCallIDs.insert(callID)
		callbacks?.state(.thinking, "Using \(name)...")

		let arguments = Self.parseArguments(item.string("arguments"))
		executeTool(name: name, arguments: arguments) { [weak self] output in
			guard let self else { return }
			self.sendJSON([
				"type": "conversation.item.create",
				"item": [
					"type": "function_call_output",
					"call_id": callID,
					"output": output,
				],
			])
			self.sendResponseCreate()
			self.callbacks?.state(.thinking, "Thinking with \(name)...")
		}
	}

	private func executeTool(name: String, arguments: [String: Any], completion: @escaping (String) -> Void) {
		guard let url = URL(string: "http://127.0.0.1:\(runtimePort)/host/tools/execute") else {
			completion(Self.toolOutput(error: "Invalid local runtime URL."))
			return
		}
		var request = URLRequest(url: url)
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try? JSONSerialization.data(withJSONObject: [
			"tool": Self.runtimeToolName(name),
			"args": arguments,
		])

		session.dataTask(with: request) { data, response, error in
			if let error {
				completion(Self.toolOutput(error: error.localizedDescription))
				return
			}
			guard let http = response as? HTTPURLResponse,
				  let data,
				  (200..<300).contains(http.statusCode) else {
				let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? "Unknown local tool error."
				completion(Self.toolOutput(error: text))
				return
			}
			completion(Self.toolOutput(data: data))
		}.resume()
	}

	private func sendJSON(_ object: [String: Any]) {
		guard JSONSerialization.isValidJSONObject(object),
			  let data = try? JSONSerialization.data(withJSONObject: object),
			  let text = String(data: data, encoding: .utf8) else { return }
		task?.send(.string(text)) { [weak self] error in
			if let error { self?.callbacks?.error("Realtime send failed: \(error.localizedDescription)") }
		}
	}

	private static func parseArguments(_ raw: String?) -> [String: Any] {
		guard let raw,
			  let data = raw.data(using: .utf8),
			  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			return [:]
		}
		return object
	}

	private static func toolOutput(data: Data) -> String {
		guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			return String(data: data, encoding: .utf8) ?? ""
		}
		if let ok = object["ok"] as? Bool, !ok {
			return toolOutput(error: (object["error"] as? String) ?? "Tool failed.")
		}
		if let result = object["result"] as? [String: Any] {
			var parts: [String] = []
			if let content = result["content"] as? [[String: Any]] {
				for item in content {
					if let text = item["text"] as? String, !text.isEmpty {
						parts.append(text)
					} else if !item.isEmpty,
							  let data = try? JSONSerialization.data(withJSONObject: item, options: [.sortedKeys]),
							  let text = String(data: data, encoding: .utf8) {
						parts.append(text)
					}
				}
			}
			if let details = result["details"],
			   !(details is NSNull),
			   JSONSerialization.isValidJSONObject(details),
			   let data = try? JSONSerialization.data(withJSONObject: details, options: [.sortedKeys]),
			   let text = String(data: data, encoding: .utf8) {
				parts.append("Details: \(text)")
			}
			if !parts.isEmpty {
				return parts.joined(separator: "\n")
			}
		}
		return String(data: data, encoding: .utf8) ?? "Tool completed."
	}

	private static func toolOutput(error: String) -> String {
		"Tool error: \(error)"
	}

	private static func realtimeTools() -> [[String: Any]] {
		[
			functionTool(
				name: "read",
				description: "Read a text or image file from the Troublemaker workspace. Useful context paths include awareness/context.jsonl, log.jsonl, and settings.json.",
				properties: [
					"label": stringSchema("Brief description of what you are reading and why."),
					"path": stringSchema("Path to the file to read, relative or absolute."),
					"offset": numberSchema("Optional 1-indexed line number to start reading from."),
					"limit": numberSchema("Optional maximum number of lines to read."),
				],
				required: ["label", "path"]
			),
			functionTool(
				name: "bash",
				description: "Run a bash command in the Troublemaker workspace. Use for searching, tests, diagnostics, git inspection, or shell operations.",
				properties: [
					"label": stringSchema("Brief description of what this command does."),
					"command": stringSchema("Bash command to execute."),
					"timeout": numberSchema("Optional timeout in seconds."),
				],
				required: ["label", "command"]
			),
			functionTool(
				name: "edit",
				description: "Edit a file by replacing exact text. Use for precise changes after reading the file.",
				properties: [
					"label": stringSchema("Brief description of the edit."),
					"path": stringSchema("Path to the file to edit."),
					"oldText": stringSchema("Exact text to replace. Must match exactly."),
					"newText": stringSchema("Replacement text."),
				],
				required: ["label", "path", "oldText", "newText"]
			),
			functionTool(
				name: "write",
				description: "Write content to a file, creating parent directories and overwriting any existing file.",
				properties: [
					"label": stringSchema("Brief description of what you are writing."),
					"path": stringSchema("Path to write."),
					"content": stringSchema("Full file content."),
				],
				required: ["label", "path", "content"]
			),
			functionTool(
				name: "list_channels",
				description: "List channels the agent has interacted with and recent Slack thread send targets.",
				properties: [:],
				required: []
			),
			functionTool(
				name: "list_threads",
				description: "List recent Slack thread targets. Use this before read_thread or send_message when choosing among active Slack threads.",
				properties: [:],
				required: []
			),
			functionTool(
				name: "get_context_briefing",
				description: "Return a compact briefing of Zip's identity, memory files, and recent persisted activity. Use this before answering context-dependent questions about Zip or prior work.",
				properties: [
					"recentLimit": numberSchema("Optional maximum recent context entries to include. Default 10, max 24."),
					"maxChars": numberSchema("Optional maximum briefing characters. Default 4000, max 8000."),
				],
				required: []
			),
			functionTool(
				name: "search_context",
				description: "Search Zip's persisted awareness, adapter log, and memory files for a specific string. Use this for questions about prior chats, names, decisions, projects, or exact terms.",
				properties: [
					"query": stringSchema("Case-insensitive text to search for in Zip's persisted context and chat logs."),
					"source": stringSchema("Optional source: all, awareness, log, or memory. Defaults to all."),
					"limit": numberSchema("Optional maximum matching entries to return. Default 12, max 30."),
				],
				required: ["query"]
			),
			functionTool(
				name: "read_thread",
				description: "Read a Slack thread transcript using a target from list_channels, such as slack:<channel>:<thread_ts>.",
				properties: [
					"target": stringSchema("Slack thread target from list_channels."),
					"limit": numberSchema("Optional maximum number of messages."),
				],
				required: ["target"]
			),
			functionTool(
				name: "send_message",
				description: "Send a user-visible message through Troublemaker to Slack, Discord, Telegram, Email, or SMS/iMessage. Use list_channels first if you need a valid target.",
				properties: [
					"label": stringSchema("Brief description of what you are sending."),
					"target": stringSchema("Required destination, e.g. slack:<channel>:<thread_ts>, email-user@example.com, phone-..., Discord snowflake, or Telegram chat ID."),
					"text": stringSchema("Message text to send."),
					"attachments": [
						"type": "array",
						"items": ["type": "string"],
						"description": "Optional absolute file paths to attach for email.",
					],
					"subject": stringSchema("Optional email subject."),
				],
				required: ["label", "target", "text"]
			),
		]
	}

	private static func functionTool(name: String, description: String, properties: [String: Any], required: [String]) -> [String: Any] {
		[
			"type": "function",
			"name": name,
			"description": description,
			"parameters": [
				"type": "object",
				"properties": properties,
				"required": required,
			],
		]
	}

	private static func stringSchema(_ description: String) -> [String: Any] {
		["type": "string", "description": description]
	}

	private static func numberSchema(_ description: String) -> [String: Any] {
		["type": "number", "description": description]
	}

	private static func runtimeToolName(_ name: String) -> String {
		name == "list_threads" ? "list_channels" : name
	}

	private static func transcriptLooksLikeEcho(_ transcript: String, assistantText: String) -> Bool {
		let transcriptNormalized = normalizedText(transcript)
		let assistantNormalized = normalizedText(assistantText)
		guard transcriptNormalized.count >= 4, assistantNormalized.count >= 4 else { return false }
		if transcriptNormalized.count >= 12,
		   assistantNormalized.contains(transcriptNormalized) {
			return true
		}
		let transcriptWords = normalizedWords(transcriptNormalized)
		let assistantWords = Set(normalizedWords(assistantNormalized))
		guard !transcriptWords.isEmpty, !assistantWords.isEmpty else { return false }
		let overlap = transcriptWords.filter { assistantWords.contains($0) }.count
		let ratio = Double(overlap) / Double(transcriptWords.count)
		if transcriptWords.count <= 2 {
			return ratio >= 1.0 && assistantNormalized.contains(transcriptNormalized)
		}
		return ratio >= 0.62
	}

	private static func normalizedText(_ text: String) -> String {
		let scalars = text.lowercased().unicodeScalars.map { scalar -> Character in
			CharacterSet.alphanumerics.contains(scalar) ? Character(scalar) : " "
		}
		return String(scalars)
			.split(separator: " ")
			.joined(separator: " ")
	}

	private static func normalizedWords(_ text: String) -> [String] {
		text.split(separator: " ")
			.map(String.init)
			.filter { $0.count > 1 }
	}
}

private enum VoiceSecretStore {
	static let services = [
		"com.tinyfatco.troublemaker.local",
		"com.tinyfatco.troublemaker.mac",
	]

	static func firstValue(accounts: [String]) throws -> String {
		for account in accounts {
			if let env = ProcessInfo.processInfo.environment[account], !env.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
				return env
			}
			for service in services {
				if let value = value(service: service, account: account) {
					return value
				}
			}
		}
		throw VoiceSecretError.missing(accounts.joined(separator: " or "))
	}

	private static func value(service: String, account: String) -> String? {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		var item: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
			  let data = item as? Data,
			  let value = String(data: data, encoding: .utf8),
			  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
			return nil
		}
		return value
	}
}

private enum VoiceSecretError: Error, CustomStringConvertible {
	case missing(String)

	var description: String {
		switch self {
		case .missing(let account):
			return "Missing voice credential: \(account)"
		}
	}
}

private enum VoiceJSON {
	static func object(_ text: String) -> [String: Any]? {
		guard let data = text.data(using: .utf8) else { return nil }
		return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
	}
}

private extension Dictionary where Key == String, Value == Any {
	func string(_ key: String) -> String? {
		self[key] as? String
	}

	func bool(_ key: String) -> Bool {
		self[key] as? Bool ?? false
	}

	func dictionary(_ key: String) -> [String: Any]? {
		self[key] as? [String: Any]
	}
}

private extension NSLock {
	func withLock<T>(_ body: () -> T) -> T {
		lock()
		defer { unlock() }
		return body()
	}
}

private extension Data {
	mutating func appendASCII(_ value: String) {
		append(value.data(using: .ascii)!)
	}

	mutating func appendLE(_ value: UInt16) {
		var value = value.littleEndian
		append(Data(bytes: &value, count: MemoryLayout<UInt16>.size))
	}

	mutating func appendLE(_ value: UInt32) {
		var value = value.littleEndian
		append(Data(bytes: &value, count: MemoryLayout<UInt32>.size))
	}
}
