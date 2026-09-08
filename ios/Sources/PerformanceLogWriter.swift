import Foundation
import WebKit

/// Destinations and filenames are native-owned; web content supplies JSON only.
final class PerformanceLogWriter {
    static let maximumBytes = 16 * 1024 * 1024
    static var defaultDirectory: URL {
        #if os(macOS)
        return Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("performance_logs", isDirectory: true)
        #else
        return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("performance_logs", isDirectory: true)
        #endif
    }

    enum SaveError: LocalizedError {
        case tooLarge, invalidJSON
        var errorDescription: String? {
            switch self {
            case .tooLarge: return "Performance report exceeds the 16 MiB limit."
            case .invalidJSON: return "Performance report must be a valid JSON object."
            }
        }
    }

    let directory: URL
    init(directory: URL = PerformanceLogWriter.defaultDirectory) {
        self.directory = directory
    }

    /// Call from the bridge's I/O queue: validation and atomic writing stay off the UI thread.
    func save(_ json: String) throws -> URL {
        guard json.utf8.count <= Self.maximumBytes else { throw SaveError.tooLarge }
        let data = Data(json.utf8)
        guard let object = try? JSONSerialization.jsonObject(with: data),
              object is [String: Any] else { throw SaveError.invalidJSON }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd_HHmmss_SSS"
        let name = "performance_\(formatter.string(from: Date()))_\(UUID().uuidString).json"
        let destination = directory.appendingPathComponent(name, isDirectory: false)
        try data.write(to: destination, options: .atomic)
        return destination
    }
}

final class PerformanceLogHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let script = """
    window.__RA2_SHELL__ = Object.assign(window.__RA2_SHELL__ || {}, {
        savePerformanceReport: payload => window.webkit.messageHandlers.performanceLogs.postMessage(payload)
    });
    """
    typealias Reply = (Any?, String?) -> Void
    private let writer: PerformanceLogWriter
    private let ioQueue = DispatchQueue(label: "ra2.performance-logs.io", qos: .utility)
    private var saving = false

    init(writer: PerformanceLogWriter = PerformanceLogWriter()) { self.writer = writer }

    static func isTrustedFrame(_ url: URL?, isMainFrame: Bool) -> Bool {
        isMainFrame && url?.scheme == "ra2app" && url?.host == "app"
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping Reply) {
        guard Self.isTrustedFrame(message.frameInfo.request.url, isMainFrame: message.frameInfo.isMainFrame) else {
            replyHandler(nil, "Only the game window can save a performance report.")
            return
        }
        guard let json = message.body as? String else {
            replyHandler(nil, "Performance report payload must be a JSON string.")
            return
        }
        guard !saving else {
            replyHandler(nil, "A performance report is already being saved.")
            return
        }
        // Bound queued work to one report, including the retained message body.
        saving = true
        ioQueue.async { [self] in
            let result = Result { try writer.save(json) }
            DispatchQueue.main.async { [self] in
                saving = false
                switch result {
                case .success(let destination): replyHandler(["path": destination.path], nil)
                case .failure(let error):
                    replyHandler(nil, "Could not save performance report to \(writer.directory.path): \(error.localizedDescription)")
                }
            }
        }
    }
}
