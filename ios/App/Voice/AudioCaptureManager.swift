@preconcurrency import AVFoundation
import Foundation

struct CapturedAudioChunk: Sendable {
    let data: Data
    let rmsLevel: Double
}

final class AudioCaptureManager {
    enum CaptureError: Error, LocalizedError {
        case microphonePermissionDenied
        case noInputDevice
        case couldNotCreateFormat
        case couldNotCreateConverter

        var errorDescription: String? {
            switch self {
            case .microphonePermissionDenied: return "Microphone permission is required."
            case .noInputDevice: return "No microphone input is available."
            case .couldNotCreateFormat: return "Could not create the 16 kHz mono audio format."
            case .couldNotCreateConverter: return "Could not create the audio converter."
            }
        }
    }

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?

    func start(onChunk: @escaping @Sendable (CapturedAudioChunk) -> Void) async throws {
        let permission = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard permission else { throw CaptureError.microphonePermissionDenied }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.allowBluetoothHFP, .duckOthers])
        try session.setPreferredSampleRate(Double(DeepgramMobileContract.sampleRate))
        try session.setActive(true)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0 else { throw CaptureError.noInputDevice }
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(DeepgramMobileContract.sampleRate),
            channels: 1,
            interleaved: false
        ) else { throw CaptureError.couldNotCreateFormat }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw CaptureError.couldNotCreateConverter
        }
        self.converter = converter

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { buffer, _ in
            guard let converted = Self.convert(buffer, using: converter, to: outputFormat),
                  let data = Self.linear16Data(from: converted) else { return }
            onChunk(.init(data: data, rmsLevel: Self.rms(from: converted)))
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func convert(
        _ buffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        to format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            outStatus.pointee = .haveData
            return buffer
        }
        return status == .error || error != nil ? nil : output
    }

    private static func linear16Data(from buffer: AVAudioPCMBuffer) -> Data? {
        guard let source = buffer.floatChannelData?[0] else { return nil }
        let count = Int(buffer.frameLength)
        var data = Data(count: count * MemoryLayout<Int16>.size)
        data.withUnsafeMutableBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<count {
                samples[index] = DeepgramMobileContract.linear16Sample(from: source[index])
            }
        }
        return data
    }

    private static func rms(from buffer: AVAudioPCMBuffer) -> Double {
        guard let source = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var total = 0.0
        for index in 0..<Int(buffer.frameLength) {
            let value = Double(source[index])
            total += value * value
        }
        return sqrt(total / Double(buffer.frameLength))
    }
}
