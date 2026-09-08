import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError(message) }
}
func reject(_ message: String, _ operation: () throws -> Void) {
    do { try operation() } catch { return }
    fatalError(message)
}

let root = FileManager.default.temporaryDirectory.appendingPathComponent("ra2-performance-tests-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
let writer = PerformanceLogWriter(directory: root.appendingPathComponent("performance_logs"))
let payload = "{\"metrics\":{\"gpu.render\":{\"p95Ms\":19.5}},\"label\":\"Test 🛠\"}"
let first = try writer.save(payload)
let second = try writer.save(payload)
require(first != second, "Reports must never overwrite each other")
require(first.deletingLastPathComponent().path == writer.directory.path, "Destination must stay in the fixed folder")
require(first.lastPathComponent.hasPrefix("performance_"), "Native filename prefix")
require(first.pathExtension == "json", "Reports must be JSON")
let saved = try String(contentsOf: first, encoding: .utf8)
require(saved == payload, "Report bytes should survive saving")
reject("Arrays must not be accepted") { _ = try writer.save("[]") }
reject("Scalars must not be accepted") { _ = try writer.save("42") }
reject("Malformed JSON must not be accepted") { _ = try writer.save("{oops") }
reject("Oversized UTF-8 JSON must not be accepted") {
    _ = try writer.save("{\"text\":\"" + String(repeating: "🛠", count: PerformanceLogWriter.maximumBytes / 4) + "\"}")
}
let blocker = root.appendingPathComponent("file-not-directory")
try Data("blocked".utf8).write(to: blocker)
reject("Directory creation errors must reach callers") {
    _ = try PerformanceLogWriter(directory: blocker).save("{}")
}
let readOnly = root.appendingPathComponent("read-only")
try FileManager.default.createDirectory(at: readOnly, withIntermediateDirectories: true)
try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: readOnly.path)
reject("Read-only destination must fail without a fallback") {
    _ = try PerformanceLogWriter(directory: readOnly).save("{}")
}
try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: readOnly.path)
require(PerformanceLogHandler.isTrustedFrame(URL(string: "ra2app://app/index.html"), isMainFrame: true), "Bundled main frame is trusted")
require(!PerformanceLogHandler.isTrustedFrame(URL(string: "ra2app://app/index.html"), isMainFrame: false), "Child frames are rejected")
require(!PerformanceLogHandler.isTrustedFrame(URL(string: "https://app/index.html"), isMainFrame: true), "Remote pages are rejected")
require(!PerformanceLogHandler.isTrustedFrame(URL(string: "ra2app://other/index.html"), isMainFrame: true), "Other hosts are rejected")
require(!PerformanceLogHandler.isTrustedFrame(nil, isMainFrame: true), "Missing origin is rejected")
let expected = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("performance_logs", isDirectory: true)
require(PerformanceLogWriter.defaultDirectory == expected, "macOS reports belong next to the app")
print("Performance log tests passed: valid JSON, unique files, bounds, invalid JSON, write errors, trusted origin, native path.")
