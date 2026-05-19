import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia
import CoreImage
import AppKit

// marec — MeetingAssistant recorder
//
// Modes:
//   marec --list-windows
//     Prints a JSON array of capturable windows to stdout and exits.
//
//   marec --output-dir <path> [--window-id <id>]
//     Records system audio + microphone into <path>/system.wav and
//     <path>/mic.wav. If --window-id is given, also captures 1fps frames of
//     that window into <path>/frames/<ms>.jpg. SIGINT to stop.
//
// All status messages are newline-delimited JSON on stdout so the Electron
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
        header.append("RIFF".data(using: .ascii)!)
        header.append(uint32LE(0))
        header.append("WAVE".data(using: .ascii)!)
        header.append("fmt ".data(using: .ascii)!)
        header.append(uint32LE(16))
        header.append(uint16LE(1))
        header.append(uint16LE(channels))
        header.append(uint32LE(sampleRate))
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        header.append(uint32LE(byteRate))
        header.append(uint16LE(channels * bitsPerSample / 8))
        header.append(uint16LE(bitsPerSample))
        header.append("data".data(using: .ascii)!)
        header.append(uint32LE(0))
        try handle.write(contentsOf: header)
    }

    func write(samples: UnsafePointer<Int16>, count: Int) {
        let bytes = count * MemoryLayout<Int16>.size
        let data = Data(bytes: samples, count: bytes)
        try? handle.write(contentsOf: data)
        dataBytes += UInt32(bytes)
    }

    func close() {
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

// MARK: - Resampler (Float -> Int16, any -> 16k mono)

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

    func convert(buffer: AVAudioPCMBuffer, onSamples: (UnsafePointer<Int16>, Int) -> Void) {
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
        if err != nil { return }
        if outBuf.frameLength == 0 { return }
        guard let ptr = outBuf.int16ChannelData?[0] else { return }
        onSamples(ptr, Int(outBuf.frameLength))
    }
}

// MARK: - Mic capture

final class MicCapture {
    private let engine = AVAudioEngine()
    private let writer: WavWriter
    private var resampler: Resampler?

    init(writer: WavWriter) { self.writer = writer }

    func start() throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else {
            throw NSError(domain: "marec.mic", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No microphone input available. Grant Microphone permission."
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

// MARK: - System audio capture (SCStream, display-wide filter)

final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: WavWriter
    private var stream: SCStream?
    private var resampler: Resampler?

    init(writer: WavWriter) { self.writer = writer }

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
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.queueDepth = 5

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "marec.audio"))
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

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let asbd = sampleBuffer.formatDescription?.audioStreamBasicDescription else { return }

        var asbdCopy = asbd
        guard let inFormat = AVAudioFormat(streamDescription: &asbdCopy) else { return }

        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard let buf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frames) else { return }
        buf.frameLength = frames

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

// MARK: - Window video capture (SCStream, single window filter)

/// Captures one window's framebuffer at ~1 fps and writes JPEG snapshots
/// named `frames/<ms_since_start>.jpg`. Works while the window is in the
/// background (Zoom/Meet keep rendering during a call).
final class WindowVideoCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let framesDir: URL
    private let startEpoch: Date
    private var stream: SCStream?
    private let ciContext = CIContext()
    private var lastSavedMs: Int64 = -10_000
    private let intervalMs: Int64

    init(framesDir: URL, startEpoch: Date, intervalSeconds: Double = 2.0) {
        self.framesDir = framesDir
        self.startEpoch = startEpoch
        self.intervalMs = Int64(intervalSeconds * 1000.0)
    }

    func start(windowID: CGWindowID) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let target = content.windows.first(where: { $0.windowID == windowID }) else {
            throw NSError(domain: "marec.video", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Window id \(windowID) not found among shareable windows."
            ])
        }

        let filter = SCContentFilter(desktopIndependentWindow: target)

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = false
        cfg.width = max(640, Int(target.frame.width))
        cfg.height = max(360, Int(target.frame.height))
        // Cap at a reasonable size to keep JPEGs small.
        if cfg.width > 1600 { cfg.width = 1600 }
        if cfg.height > 1000 { cfg.height = 1000 }
        cfg.scalesToFit = true
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 2) // request 2fps, we save every ~intervalSeconds
        cfg.queueDepth = 5
        cfg.pixelFormat = kCVPixelFormatType_32BGRA

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "marec.window"))
        try await s.startCapture()
        self.stream = s
    }

    func stop() async {
        if let s = stream {
            try? await s.stopCapture()
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let nowMs = Int64(Date().timeIntervalSince(startEpoch) * 1000.0)
        if nowMs - lastSavedMs < intervalMs { return }
        lastSavedMs = nowMs

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvImageBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else { return }

        let name = String(format: "%010d.jpg", nowMs)
        let url = framesDir.appendingPathComponent(name)
        try? data.write(to: url)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["status": "video_stream_error", "message": error.localizedDescription])
    }
}

// MARK: - Window enumeration

func listWindowsAndExit() async -> Never {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        var out: [[String: Any]] = []
        for w in content.windows {
            // Skip windows with no title and no app — likely UI helpers.
            let title = w.title ?? ""
            let appName = w.owningApplication?.applicationName ?? ""
            if title.isEmpty && appName.isEmpty { continue }
            if w.frame.width < 200 || w.frame.height < 200 { continue }
            out.append([
                "id": w.windowID,
                "app": appName,
                "title": title,
                "bundleId": w.owningApplication?.bundleIdentifier ?? "",
                "width": Int(w.frame.width),
                "height": Int(w.frame.height)
            ])
        }
        let payload: [String: Any] = ["windows": out]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(0)
    } catch {
        let payload: [String: Any] = [
            "windows": [],
            "error": error.localizedDescription
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
        exit(1)
    }
}

// MARK: - CLI

struct CliArgs {
    var listWindows = false
    var outputDir: String?
    var windowID: CGWindowID?
}

func parseArgs() -> CliArgs {
    var args = CliArgs()
    var i = 1
    let arr = CommandLine.arguments
    while i < arr.count {
        switch arr[i] {
        case "--list-windows":
            args.listWindows = true
        case "--output-dir":
            i += 1
            if i < arr.count { args.outputDir = arr[i] }
        case "--window-id":
            i += 1
            if i < arr.count, let id = UInt32(arr[i]) {
                args.windowID = CGWindowID(id)
            }
        case "-h", "--help":
            print("Usage:")
            print("  marec --list-windows")
            print("  marec --output-dir <path> [--window-id <id>]")
            exit(0)
        default:
            break
        }
        i += 1
    }
    return args
}

let cli = parseArgs()

if cli.listWindows {
    Task {
        await listWindowsAndExit()
    }
    dispatchMain()
}

guard let dir = cli.outputDir else {
    fail("--output-dir is required (or use --list-windows)")
}

let outDir = URL(fileURLWithPath: (dir as NSString).expandingTildeInPath)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let micURL = outDir.appendingPathComponent("mic.wav")
let sysURL = outDir.appendingPathComponent("system.wav")
let framesDir = outDir.appendingPathComponent("frames")

let micWriter: WavWriter
let sysWriter: WavWriter
do {
    micWriter = try WavWriter(url: micURL)
    sysWriter = try WavWriter(url: sysURL)
} catch {
    fail("could not open output wavs: \(error.localizedDescription)")
}

let mic = MicCapture(writer: micWriter)
let sysCap = SystemAudioCapture(writer: sysWriter)

var videoCap: WindowVideoCapture?
if cli.windowID != nil {
    try? FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)
    videoCap = WindowVideoCapture(framesDir: framesDir, startEpoch: Date(), intervalSeconds: 2.0)
}

emit([
    "status": "starting",
    "outputDir": outDir.path,
    "windowId": cli.windowID.map { Int($0) } as Any,
    "pid": ProcessInfo.processInfo.processIdentifier
])

let startedAt = Date()

do {
    try mic.start()
    emit(["status": "mic_started"])
} catch {
    fail("mic start failed: \(error.localizedDescription)")
}

Task {
    do {
        try await sysCap.start()
        emit(["status": "system_started"])
    } catch {
        emit(["status": "system_start_failed", "message": error.localizedDescription])
    }
    if let v = videoCap, let wid = cli.windowID {
        do {
            try await v.start(windowID: wid)
            emit(["status": "video_started", "windowId": Int(wid)])
        } catch {
            emit(["status": "video_start_failed", "message": error.localizedDescription])
        }
    }
    emit(["status": "recording"])
}

let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let stopHandler: () -> Void = {
    emit(["status": "stopping"])
    mic.stop()
    Task {
        await sysCap.stop()
        if let v = videoCap { await v.stop() }
        let duration = Date().timeIntervalSince(startedAt)
        var payload: [String: Any] = [
            "status": "done",
            "mic": micURL.path,
            "system": sysURL.path,
            "duration": duration
        ]
        if cli.windowID != nil {
            payload["frames"] = framesDir.path
        }
        emit(payload)
        exit(0)
    }
}
sigSrc.setEventHandler(handler: stopHandler)
sigTerm.setEventHandler(handler: stopHandler)
sigSrc.resume()
sigTerm.resume()

dispatchMain()
