import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

// marec — MeetingAssistant recorder
// Captures system audio (via ScreenCaptureKit) + microphone (via AVAudioEngine)
// into two separate 16kHz mono PCM16 WAV files. Press Ctrl+C / send SIGINT to stop.
//
// Usage: marec --output-dir <path>
//
// On stdout it prints newline-delimited JSON status messages so the Electron
// host can track lifecycle.

// MARK: - JSON helpers

func emit(_ payload: [String: Any]) {
    var p = payload
    p["ts"] = Date().timeIntervalSince1970
    if let data = try? JSONSerialization.data(withJSONObject: p, options: []),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

func fail(_ msg: String, code: Int32 = 1) -> Never {
    emit(["status": "error", "message": msg])
    exit(code)
}

// MARK: - WAV writer (16kHz mono PCM16)

final class WavWriter {
    let url: URL
    private var handle: FileHandle
    private var dataBytes: UInt32 = 0
    private let sampleRate: UInt32 = 16_000
    private let channels: UInt16 = 1
    private let bitsPerSample: UInt16 = 16

    init(url: URL) throws {
        self.url = url
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.handle = try FileHandle(forWritingTo: url)
        try writeHeader()
    }

    private func writeHeader() throws {
        var header = Data()
        // RIFF chunk
        header.append("RIFF".data(using: .ascii)!)
        header.append(uint32LE(0))                  // file size - 8, patched on close
        header.append("WAVE".data(using: .ascii)!)
        // fmt chunk
        header.append("fmt ".data(using: .ascii)!)
        header.append(uint32LE(16))                  // PCM fmt chunk size
        header.append(uint16LE(1))                   // PCM format
        header.append(uint16LE(channels))
        header.append(uint32LE(sampleRate))
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        header.append(uint32LE(byteRate))
        header.append(uint16LE(channels * bitsPerSample / 8))
        header.append(uint16LE(bitsPerSample))
        // data chunk header
        header.append("data".data(using: .ascii)!)
        header.append(uint32LE(0))                   // data size, patched on close
        try handle.write(contentsOf: header)
    }

    func write(samples: UnsafePointer<Int16>, count: Int) {
        let bytes = count * MemoryLayout<Int16>.size
        let data = Data(bytes: samples, count: bytes)
        try? handle.write(contentsOf: data)
        dataBytes += UInt32(bytes)
    }

    func close() {
        // Patch RIFF size and data size.
        let fileSizeMinus8 = 36 + dataBytes
        try? handle.seek(toOffset: 4)
        try? handle.write(contentsOf: uint32LE(fileSizeMinus8))
        try? handle.seek(toOffset: 40)
        try? handle.write(contentsOf: uint32LE(dataBytes))
        try? handle.close()
    }

    private func uint32LE(_ v: UInt32) -> Data {
        var x = v.littleEndian
        return Data(bytes: &x, count: 4)
    }
    private func uint16LE(_ v: UInt16) -> Data {
        var x = v.littleEndian
        return Data(bytes: &x, count: 2)
    }
}

// MARK: - Resampler / converter (Float -> Int16, any -> 16k mono)

final class Resampler {
    private let converter: AVAudioConverter
    private let outFormat: AVAudioFormat

    init?(inFormat: AVAudioFormat) {
        guard let target = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: true
        ) else { return nil }
        guard let conv = AVAudioConverter(from: inFormat, to: target) else { return nil }
        conv.sampleRateConverterQuality = .max
        self.converter = conv
        self.outFormat = target
    }

    /// Convert and call back with Int16 samples.
    func convert(buffer: AVAudioPCMBuffer, onSamples: (UnsafePointer<Int16>, Int) -> Void) {
        // Estimate capacity (allow generous slack for resampling).
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }

        var supplied = false
        let block: AVAudioConverterInputBlock = { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        var err: NSError?
        _ = converter.convert(to: outBuf, error: &err, withInputFrom: block)
        if let e = err {
            FileHandle.standardError.write("convert error: \(e.localizedDescription)\n".data(using: .utf8)!)
            return
        }
        if outBuf.frameLength == 0 { return }
        guard let ptr = outBuf.int16ChannelData?[0] else { return }
        onSamples(ptr, Int(outBuf.frameLength))
    }
}

// MARK: - Mic capture (AVAudioEngine)

final class MicCapture {
    private let engine = AVAudioEngine()
    private let writer: WavWriter
    private var resampler: Resampler?

    init(writer: WavWriter) {
        self.writer = writer
    }

    func start() throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else {
            throw NSError(domain: "marec.mic", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No microphone input available (sampleRate=0). Grant Microphone permission in System Settings > Privacy."
            ])
        }
        guard let r = Resampler(inFormat: inFormat) else {
            throw NSError(domain: "marec.mic", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Could not build mic resampler."
            ])
        }
        self.resampler = r
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buf, _ in
            self?.resampler?.convert(buffer: buf) { samples, count in
                self?.writer.write(samples: samples, count: count)
            }
        }
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        writer.close()
    }
}

// MARK: - System capture (ScreenCaptureKit)

final class SystemCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: WavWriter
    private var stream: SCStream?
    private var resampler: Resampler?

    init(writer: WavWriter) {
        self.writer = writer
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "marec.system", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No display available for ScreenCaptureKit."
            ])
        }
        let pid = ProcessInfo.processInfo.processIdentifier
        let excluded = content.applications.filter { $0.processID == pid }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        // Minimize video work — we only want audio.
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.queueDepth = 5

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "marec.audio"))
        // We must add a screen output too (SCKit requirement on some macOS versions).
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "marec.video"))
        try await s.startCapture()
        self.stream = s
    }

    func stop() async {
        if let s = stream {
            try? await s.stopCapture()
        }
        writer.close()
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let asbd = sampleBuffer.formatDescription?.audioStreamBasicDescription else { return }

        var asbdCopy = asbd
        guard let inFormat = AVAudioFormat(streamDescription: &asbdCopy) else { return }

        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard let buf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frames) else { return }
        buf.frameLength = frames

        // Copy the audio data out of the CMSampleBuffer's block buffer.
        guard let blockBuf = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var lengthOut = 0
        var dataPtr: UnsafeMutablePointer<Int8>?
        if CMBlockBufferGetDataPointer(blockBuf, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &lengthOut, dataPointerOut: &dataPtr) != noErr {
            return
        }
        guard let src = dataPtr else { return }

        let bytesPerFrame = Int(inFormat.streamDescription.pointee.mBytesPerFrame)
        let common: AVAudioCommonFormat = inFormat.commonFormat
        if common == AVAudioCommonFormat.pcmFormatFloat32 {
            if let dest = buf.floatChannelData?[0] {
                memcpy(dest, src, Int(frames) * bytesPerFrame)
            }
        } else if common == AVAudioCommonFormat.pcmFormatInt16, let dest = buf.int16ChannelData?[0] {
            memcpy(dest, src, Int(frames) * bytesPerFrame)
        }

        if resampler == nil {
            resampler = Resampler(inFormat: inFormat)
        }
        resampler?.convert(buffer: buf) { [weak self] samples, count in
            self?.writer.write(samples: samples, count: count)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["status": "system_stream_error", "message": error.localizedDescription])
    }
}

// MARK: - CLI

func parseArgs() -> URL {
    var outputDir: String?
    var i = 1
    let args = CommandLine.arguments
    while i < args.count {
        switch args[i] {
        case "--output-dir":
            i += 1
            if i < args.count { outputDir = args[i] }
        case "-h", "--help":
            print("Usage: marec --output-dir <path>")
            print("Records system audio + microphone to <path>/system.wav and <path>/mic.wav.")
            print("Send SIGINT (Ctrl+C) to stop.")
            exit(0)
        default:
            break
        }
        i += 1
    }
    guard let dir = outputDir else { fail("--output-dir is required") }
    let url = URL(fileURLWithPath: (dir as NSString).expandingTildeInPath)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

let outDir = parseArgs()
let micURL = outDir.appendingPathComponent("mic.wav")
let sysURL = outDir.appendingPathComponent("system.wav")

let micWriter: WavWriter
let sysWriter: WavWriter
do {
    micWriter = try WavWriter(url: micURL)
    sysWriter = try WavWriter(url: sysURL)
} catch {
    fail("could not open output wavs: \(error.localizedDescription)")
}

let mic = MicCapture(writer: micWriter)
let sys = SystemCapture(writer: sysWriter)

emit(["status": "starting", "outputDir": outDir.path, "pid": ProcessInfo.processInfo.processIdentifier])

let startedAt = Date()
let group = DispatchGroup()
let runLoopSem = DispatchSemaphore(value: 0)

// Start mic synchronously.
do {
    try mic.start()
    emit(["status": "mic_started"])
} catch {
    fail("mic start failed: \(error.localizedDescription)")
}

// Start system capture async.
Task {
    do {
        try await sys.start()
        emit(["status": "system_started"])
        emit(["status": "recording"])
    } catch {
        emit(["status": "system_start_failed", "message": error.localizedDescription])
        // Continue recording mic only — degrade gracefully.
    }
}

// SIGINT handler: stop cleanly, write headers, exit.
let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let stopHandler: () -> Void = {
    emit(["status": "stopping"])
    mic.stop()
    Task {
        await sys.stop()
        let duration = Date().timeIntervalSince(startedAt)
        emit([
            "status": "done",
            "mic": micURL.path,
            "system": sysURL.path,
            "duration": duration
        ])
        exit(0)
    }
}
sigSrc.setEventHandler(handler: stopHandler)
sigTerm.setEventHandler(handler: stopHandler)
sigSrc.resume()
sigTerm.resume()

// Block forever until SIGINT.
dispatchMain()
