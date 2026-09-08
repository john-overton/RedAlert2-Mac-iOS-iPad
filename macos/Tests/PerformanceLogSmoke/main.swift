// Native WKWebView integration test; no retail assets or player profile used.
import AppKit
import WebKit

final class FixtureScheme: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let data = Data("<!doctype html><html><body>Performance report bridge test</body></html>".utf8)
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// The executable supplies its own scratch directory and never touches real logs.
let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("ra2-performance-smoke-\(UUID().uuidString)", isDirectory: true)
try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
final class TestApp: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var view: WKWebView!
    var window: NSWindow!
    var phase = 0
    let payload = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    func applicationDidFinishLaunching(_ notification: Notification) {
        launch(directory: scratch.appendingPathComponent("performance_logs"), host: "app")
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { self.finish("Native report bridge timed out") }
    }
    func launch(directory: URL, host: String) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(FixtureScheme(), forURLScheme: "ra2app")
        let handler = PerformanceLogHandler(writer: PerformanceLogWriter(directory: directory))
        config.userContentController.addScriptMessageHandler(handler, contentWorld: .page, name: "performanceLogs")
        config.userContentController.addUserScript(WKUserScript(source: "window.__RA2_SHELL__={existingBridge:true};", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: PerformanceLogHandler.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        view = WKWebView(frame: NSRect(x:0,y:0,width:800,height:600), configuration: config)
        view.navigationDelegate = self
        window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        view.load(URLRequest(url: URL(string:"ra2app://\(host)/test")!))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let script: String
        if phase == 0 {
            script = #"""
            const shell=window.__RA2_SHELL__;
            if(!shell.existingBridge)throw Error('Existing shell bridge overwritten');
            const saved=await shell.savePerformanceReport(payload);
            if(typeof saved.path!=='string')throw Error('Missing output path');
            const frame=document.createElement('iframe');frame.src='ra2app://app/frame';
            const loaded=new Promise(r=>frame.onload=r);document.body.append(frame);await loaded;
            let denied=false;
            try{await frame.contentWindow.webkit.messageHandlers.performanceLogs.postMessage(payload);}
            catch(error){denied=/game window|trusted|main.frame/i.test(String(error));if(!denied)throw error;}
            if(!denied)throw Error('Subframe was not denied');
            return saved.path;
            """#
        } else {
            script = #"""
            try{await window.__RA2_SHELL__.savePerformanceReport(payload);throw Error('Save unexpectedly succeeded');}
            catch(error){if(String(error).includes('unexpectedly succeeded'))throw error;return String(error);}
            """#
        }
        webView.callAsyncJavaScript(script, arguments:["payload":payload], in:nil, in:.page) { result in
            do {
                let value = try result.get()
                if self.phase == 0 {
                    guard let path = value as? String else { throw NSError(domain:"Invalid saved path",code:1) }
                    let url = URL(fileURLWithPath:path)
                    guard url.deletingLastPathComponent().standardizedFileURL == scratch.appendingPathComponent("performance_logs").standardizedFileURL,
                          try Data(contentsOf:url) == Data(self.payload.utf8) else { throw NSError(domain:"Saved bytes/path mismatch",code:1) }
                    print("PASS trusted native promise, exact real report bytes (\(self.payload.utf8.count)), path, preserved bridge, subframe denial")
                    self.phase=1;self.launch(directory:scratch.appendingPathComponent("untrusted"),host:"untrusted")
                } else if self.phase == 1 {
                    guard !FileManager.default.fileExists(atPath:scratch.appendingPathComponent("untrusted").path) else { throw NSError(domain:"Untrusted save wrote files",code:1) }
                    guard String(describing:value).contains("Only the game window") else { throw NSError(domain:"Unexpected untrusted error",code:1) }
                    print("PASS untrusted origin denied: \(value)")
                    let blocked=scratch.appendingPathComponent("blocked")
                    try Data("not a directory".utf8).write(to:blocked)
                    self.phase=2;self.launch(directory:blocked.appendingPathComponent("performance_logs"),host:"app")
                } else {
                    print("PASS write failure rejected promise: \(value)")
                    self.finish(nil)
                }
            } catch { self.finish(String(describing:error)) }
        }
    }
    func finish(_ error:String?) {
        try? FileManager.default.removeItem(at:scratch)
        if let error { fputs("\(error)\n",stderr);exit(1) }
        exit(0)
    }
}
let app=NSApplication.shared
let delegate=TestApp()
app.setActivationPolicy(.accessory)
app.delegate=delegate
app.run()
