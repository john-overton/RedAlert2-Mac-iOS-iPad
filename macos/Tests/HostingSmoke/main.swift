// Native WKWebView bridge integration test; no retail assets or game profile used.
import AppKit
import WebKit

final class FixtureScheme: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let data = Data("<!doctype html><html><body>Mac hosting bridge test</body></html>".utf8)
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
final class TestApp: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let host = MultiplayerHost(executable: URL(fileURLWithPath: CommandLine.arguments[1]))
    var view: WKWebView!
    var window: NSWindow!
    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        // OPFS is unavailable in ephemeral WKWebView stores. Use a dedicated
        // test profile, never the player's campaign/save profile.
        config.websiteDataStore = CommandLine.arguments.count > 2
            ? WKWebsiteDataStore(forIdentifier: UUID(uuidString: "AF7A1F99-2663-4F42-8FA9-46C8CCDE34A2")!) : .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.addUserScript(WKUserScript(source: "window.__hostingErrors=[];window.__hostingLogs=[];for(const name of ['log','warn','error']){const original=console[name];console[name]=(...args)=>{window.__hostingLogs.push(args.map(String).join(' '));window.__hostingLogs=window.__hostingLogs.slice(-10);original(...args)}};addEventListener('error',e=>window.__hostingErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__hostingErrors.push(String(e.reason)));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.setURLSchemeHandler(CommandLine.arguments.count > 2 ? BundleSchemeHandler() : FixtureScheme(), forURLScheme: "ra2app")
        config.userContentController.addScriptMessageHandler(host, contentWorld: .page, name: "multiplayer")
        config.userContentController.addUserScript(WKUserScript(source: MultiplayerHost.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        view = WKWebView(frame: NSRect(x:0,y:0,width:800,height:600), configuration: config)
        view.navigationDelegate = self
        window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        if CommandLine.arguments.count > 2 { window.orderFront(nil) }
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.view.evaluateJavaScript("JSON.stringify({text:document.body.innerText.slice(-1200),errors:window.__hostingErrors,logs:window.__hostingLogs,url:location.href,resources:performance.getEntriesByType('resource').slice(-4).map(r=>r.name)})") { value, error in
                print("UI status: \(value ?? error as Any)"); fflush(stdout)
            }
        }
        view.load(URLRequest(url: URL(string: CommandLine.arguments.count > 2 ? "ra2app://app/index.html" : "ra2app://app/test")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + (CommandLine.arguments.count > 2 ? 300 : 60)) { self.finish("Native bridge test timed out") }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let fixtureScript = #"""
        const shell = window.__RA2_SHELL__;
        const identity = {protocol:2,ordersProtocol:2,engine:'yr',mod:'base',version:'native-test',modHash:'rules',assetFingerprint:'retail'};
        const options = {identity,port:19721,password:'test',gameOpts:{gameMode:0,gameSpeed:3,maxSlots:4,humanPlayers:[],aiPlayers:[],mapName:'test.map',mapDigest:'digest'}};
        const assert = (value,message) => {if(!value)throw Error(message)};
        const rejected = async (fn,pattern) => {
            try {await fn()} catch(error) {assert(pattern.test(String(error)),String(error));return}
            throw Error('Expected rejection: '+pattern);
        };
        await rejected(()=>shell.hostGame({...options,port:65536}),/Port|stopped/);
        await shell.stopHosting();
        const first = await shell.hostGame(options);
        assert(first.port===options.port && Array.isArray(first.addresses),'Bad readiness result');
        await rejected(()=>shell.hostGame(options),/already/);
        // The same WebSocket API used by the shipped game must work in WKWebView.
        const connect = name => new Promise((resolve,reject)=>{
            const socket = new WebSocket(`ws://127.0.0.1:${first.port}`);
            socket.onopen=()=>socket.send(JSON.stringify({...identity,type:'hello',name,password:'test'}));
            socket.onerror=()=>reject(Error('WKWebView WebSocket failed'));
            socket.onmessage=event=>{
                const message=JSON.parse(event.data);
                if(message.type==='welcome')resolve({socket,message});
                if(message.type==='error')reject(Error(JSON.stringify(message)));
            };
        });
        const host=await connect('Native host');
        const guest=await connect('Native guest');
        assert(guest.message.session.clients.length===2,'Guest did not join native host');
        const closed=new Promise(resolve=>guest.socket.onclose=resolve);
        await shell.stopHosting(); await closed;
        await shell.hostGame(options); await shell.stopHosting();
        // Both calls arrive before startup is ready: cancellation must settle both.
        const pending=shell.hostGame(options);
        const stopping=shell.stopHosting();
        await rejected(()=>pending,/cancelled/); await stopping;
        await shell.hostGame(options); await shell.stopHosting();
        const iframe=document.createElement('iframe'); iframe.src='ra2app://app/frame';
        document.body.append(iframe);await new Promise(resolve=>iframe.onload=resolve);
        await rejected(()=>iframe.contentWindow.webkit.messageHandlers.multiplayer.postMessage({action:'host',options}),/Only the game window/);
        return 'Native bridge: host/guest sockets, duplicate host, invalid port, stop/rehost, cancellation, iframe rejection passed';
        """#
        let script = CommandLine.arguments.count > 2 ? (try! String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)) : fixtureScript
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value): print(value); self.finish(nil)
            case .failure(let error):
                // First asset import reloads the page; didFinish runs the UI
                // check again in the new document once the seed is complete.
                if CommandLine.arguments.count > 2 && String(describing: error).contains("no longer reachable") { return }
                self.finish(String(describing: error))
            }
        }
    }
    func finish(_ error: String?) {
        host.stop { _, _ in
            if let error { fputs("\(error)\n", stderr); exit(1) }
            exit(0)
        }
    }
}
let app = NSApplication.shared
let delegate = TestApp()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
