import Foundation
import WebKit

/// One server process per game window; only the bundled main frame may control it.
final class MultiplayerHost: NSObject, WKScriptMessageHandlerWithReply {
    static let script = """
    window.__RA2_SHELL__ = {
        platform: 'macos', version: '0.1.0',
        exitApp: () => window.webkit.messageHandlers.exitApp.postMessage(null),
        hostGame: options => window.webkit.messageHandlers.multiplayer.postMessage({action:'host', options}),
        stopHosting: () => window.webkit.messageHandlers.multiplayer.postMessage({action:'stop'})
    };
    """
    typealias Reply = (Any?, String?) -> Void
    private let executable: URL
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var response = Data()
    private var startReply: Reply?
    private var stopReplies: [Reply] = []
    private var stopping = false

    init(executable: URL) { self.executable = executable }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping Reply) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "ra2app",
              message.frameInfo.request.url?.host == "app" else {
            replyHandler(nil, "Only the game window can manage a multiplayer server.")
            return
        }
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "Invalid hosting request.")
            return
        }
        switch action {
        case "host": start(body["options"], reply: replyHandler)
        case "stop": stop(reply: replyHandler)
        default: replyHandler(nil, "Unknown hosting request.")
        }
    }

    private func start(_ options: Any?, reply: @escaping Reply) {
        guard process == nil else { reply(nil, "A game is already being hosted. Leave it first."); return }
        guard let options = options as? [String: Any], JSONSerialization.isValidJSONObject(options),
              var bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 128 * 1024 - 1 else {
            reply(nil, "Invalid hosting options."); return
        }
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            reply(nil, "The multiplayer server is missing. Rebuild or reinstall the Mac app."); return
        }
        bytes.append(10)
        let child = Process()
        let stdin = Pipe(), stdout = Pipe()
        child.executableURL = executable
        child.standardInput = stdin
        child.standardOutput = stdout
        child.standardError = FileHandle.nullDevice
        // No user runtime flags or module paths may alter the bundled helper.
        child.environment = ["PATH":"/usr/bin:/bin", "TMPDIR":NSTemporaryDirectory()]
        process = child; input = stdin; output = stdout
        response = Data(); startReply = reply; stopping = false
        stdout.fileHandleForReading.readabilityHandler = { [weak self, weak child] handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard let self, let child, self.process === child else { return }
                self.receive(data)
            }
        }
        child.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard let self, self.process === child else { return }
                self.finished()
            }
        }
        do {
            try child.run()
            try stdin.fileHandleForWriting.write(contentsOf: bytes)
        } catch {
            let callback = startReply; startReply = nil
            callback?(nil, "Could not start hosting: \(error.localizedDescription)")
            if child.isRunning { stop() } else { finished() }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self, weak child] in
            guard let self, let child, self.process === child, self.startReply != nil else { return }
            let callback = self.startReply; self.startReply = nil
            callback?(nil, "The multiplayer server did not start in time.")
            self.stop()
        }
    }

    private func receive(_ data: Data) {
        guard !data.isEmpty, startReply != nil else { return }
        response.append(data)
        guard response.count <= 64 * 1024 else {
            let callback = startReply; startReply = nil
            callback?(nil, "Invalid response from the multiplayer server.")
            stop(); return
        }
        guard let newline = response.firstIndex(of: 10) else { return }
        let callback = startReply; startReply = nil
        guard let value = (try? JSONSerialization.jsonObject(with: response[..<newline])) as? [String: Any] else {
            callback?(nil, "Invalid response from the multiplayer server.")
            stop(); return
        }
        if let error = value["error"] as? String {
            callback?(nil, error); stop(); return
        }
        guard let port = value["port"] as? Int, (1...65535).contains(port), value["addresses"] is [String] else {
            callback?(nil, "Invalid response from the multiplayer server.")
            stop(); return
        }
        callback?(value, nil)
    }

    func stop(reply: Reply? = nil) {
        guard let child = process else { reply?(NSNull(), nil); return }
        if let reply { stopReplies.append(reply) }
        guard !stopping else { return }
        stopping = true
        let callback = startReply; startReply = nil
        callback?(nil, "Hosting was cancelled.")
        try? input?.fileHandleForWriting.close()
        if child.isRunning { child.terminate() }
        // Termination replies wait until the listener has actually gone away,
        // so immediate rehosting can reuse the same port.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self, weak child] in
            guard let self, let child, self.process === child, child.isRunning else { return }
            kill(child.processIdentifier, SIGKILL)
        }
    }

    private func finished() {
        output?.fileHandleForReading.readabilityHandler = nil
        // Drain a final error written immediately before helper exit.
        if startReply != nil, let handle = output?.fileHandleForReading {
            receive(handle.readDataToEndOfFile())
        }
        let callback = startReply; startReply = nil
        callback?(nil, "The multiplayer server stopped before hosting was ready.")
        try? input?.fileHandleForWriting.close()
        try? output?.fileHandleForReading.close()
        input = nil; output = nil; process = nil; response = Data(); stopping = false
        let replies = stopReplies; stopReplies = []
        for reply in replies { reply(NSNull(), nil) }
    }
}
