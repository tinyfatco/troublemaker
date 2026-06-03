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
	var error: (String) -> Void
}

protocol VoiceSessionProvider: AnyObject {
	var kind: VoiceProviderKind { get }
	var targetSampleRate: Double { get }
	var callbacks: VoiceProviderCallbacks? { get set }
	func connect() throws
	func sendAudio(_ pcm16: Data)
	func stop()
}

final class MacVoiceSession: NSObject, AVAudioPlayerDelegate {
	var onStateChange: ((VoiceRuntimeState, String) -> Void)?
	var onPartialTranscript: ((String) -> Void)?
	var onFinalTranscript: ((String) -> Void)?
	var onAssistantTextDelta: ((String) -> Void)?
	var onAssistantTextFinal: ((String) -> Void)?

	private let audioEngine = AVAudioEngine()
	private let lock = NSLock()
	private var provider: VoiceSessionProvider?
	private var state: VoiceRuntimeState = .idle
	private var player: AVAudioPlayer?
	private var pendingAudio = Data()
	private var pendingAudioFormat: VoiceAudioPayload?
	private var micSuppressed = false

	func start(kind: VoiceProviderKind, localVoicePort: Int = 8766, agentName: String) async {
		stop()
		setState(.connecting, "Connecting \(kind.title)...")

		guard await requestMicrophoneAccess() else {
			setState(.error, "Microphone access denied.")
			return
		}

		do {
			let provider = try makeProvider(kind: kind, localVoicePort: localVoicePort, agentName: agentName)
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
		lock.withLock {
			pendingAudio.removeAll()
			pendingAudioFormat = nil
			micSuppressed = false
		}
		setState(.idle, "Voice stopped.")
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
			error: { [weak self] message in self?.setState(.error, message) }
		)
	}

	private func makeProvider(kind: VoiceProviderKind, localVoicePort: Int, agentName: String) throws -> VoiceSessionProvider {
		switch kind {
		case .localTroublemaker:
			return LocalTroublemakerVoiceProvider(port: localVoicePort)
		case .openAIRealtime:
			let apiKey = try VoiceSecretStore.firstValue(accounts: ["OPENAI_API_KEY", "MOM_OPENAI_API_KEY"])
			return OpenAIRealtimeVoiceProvider(apiKey: apiKey, agentName: agentName)
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
		lock.withLock {
			micSuppressed = true
			switch payload {
			case .encoded(let data):
				if case .encoded? = pendingAudioFormat {
					pendingAudio.append(data)
				} else {
					pendingAudio = data
					pendingAudioFormat = payload
				}
			case .pcm16(let data, let sampleRate):
				if case .pcm16(_, sampleRate)? = pendingAudioFormat {
					pendingAudio.append(data)
				} else {
					pendingAudio = data
					pendingAudioFormat = payload
				}
			}
		}
		setState(.speaking, "Speaking...")
	}

	private func flushAudioIfNeeded() {
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
		guard let payload else { return }

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
			player.play()
		} catch {
			lock.withLock { micSuppressed = false }
			setState(.listening, "Listening...")
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
		lock.withLock { state = newState }
		if newState == .listening {
			flushAudioIfNeeded()
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
	private let session: URLSession
	private var task: URLSessionWebSocketTask?

	init(apiKey: String, agentName: String) {
		self.apiKey = apiKey
		self.agentName = agentName
		session = URLSession(configuration: .default)
	}

	func connect() throws {
		var request = URLRequest(url: URL(string: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2")!)
		request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
		let task = session.webSocketTask(with: request)
		self.task = task
		task.resume()
		sendSessionUpdate()
		callbacks?.state(.listening, "Listening with Realtime 2...")
		receive()
	}

	func sendAudio(_ pcm16: Data) {
		let event: [String: Any] = [
			"type": "input_audio_buffer.append",
			"audio": pcm16.base64EncodedString(),
		]
		sendJSON(event)
	}

	func stop() {
		task?.cancel(with: .normalClosure, reason: nil)
		task = nil
	}

	private func sendSessionUpdate() {
		let instructions = "You are the Realtime 2 voice input layer in the Troublemaker Mac app for \(agentName). Capture the user's spoken request exactly and keep any spoken acknowledgement very brief because the local Troublemaker runtime performs the actual work."
		sendJSON([
			"type": "session.update",
			"session": [
				"type": "realtime",
				"model": "gpt-realtime-2",
				"output_modalities": ["audio", "text"],
				"instructions": instructions,
				"reasoning": ["effort": "low"],
				"audio": [
					"input": [
						"format": ["type": "audio/pcm", "rate": 24000],
						"turn_detection": ["type": "server_vad", "create_response": true],
						"transcription": ["model": "gpt-realtime-whisper"],
					],
					"output": [
						"format": ["type": "audio/pcm", "rate": 24000],
						"voice": "alloy",
						"speed": 1.0,
					],
				],
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
		case "session.created", "session.updated":
			callbacks?.state(.listening, "Realtime 2 ready.")
		case "input_audio_buffer.speech_started":
			callbacks?.state(.transcribing, "Speech detected...")
		case "input_audio_buffer.speech_stopped", "input_audio_buffer.committed":
			callbacks?.state(.thinking, "Realtime 2 is thinking...")
		case "conversation.item.input_audio_transcription.delta":
			callbacks?.partialTranscript(event.string("delta") ?? "")
		case "conversation.item.input_audio_transcription.completed":
			callbacks?.finalTranscript(event.string("transcript") ?? "")
		case "response.output_text.delta", "response.audio_transcript.delta", "response.output_audio_transcript.delta":
			callbacks?.assistantTextDelta(event.string("delta") ?? "")
			callbacks?.state(.speaking, "Realtime 2 is speaking...")
		case "response.output_text.done", "response.output_audio_transcript.done":
			callbacks?.assistantTextFinal(event.string("text") ?? event.string("transcript") ?? "")
		case "response.output_audio.delta", "response.audio.delta":
			if let delta = event.string("delta"), let data = Data(base64Encoded: delta) {
				callbacks?.audio(.pcm16(data, sampleRate: 24000))
			}
		case "response.output_audio.done", "response.audio.done", "response.done":
			callbacks?.state(.listening, "Listening with Realtime 2...")
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

	private func sendJSON(_ object: [String: Any]) {
		guard JSONSerialization.isValidJSONObject(object),
			  let data = try? JSONSerialization.data(withJSONObject: object),
			  let text = String(data: data, encoding: .utf8) else { return }
		task?.send(.string(text)) { [weak self] error in
			if let error { self?.callbacks?.error("Realtime send failed: \(error.localizedDescription)") }
		}
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
