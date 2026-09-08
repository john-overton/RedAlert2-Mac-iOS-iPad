import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let multiplayer = MultiplayerHost(executable: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/RA2Server"))
    private let performanceLogs = PerformanceLogHandler()
    private var mouseMonitor: Any?
    private var commandClickActive = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Red Alert 2", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        let fullscreen = viewMenu.addItem(withTitle: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.control, .command]
        viewItem.submenu = viewMenu
        menu.addItem(viewItem)
        NSApp.mainMenu = menu

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        config.userContentController.add(self, name: "exitApp")
        config.userContentController.addScriptMessageHandler(performanceLogs, contentWorld: .page, name: "performanceLogs")
        config.userContentController.addScriptMessageHandler(multiplayer, contentWorld: .page, name: "multiplayer")
        config.userContentController.addUserScript(WKUserScript(
            source: MultiplayerHost.script,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(
            source: PerformanceLogHandler.script,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        // Opt in locally for Safari's Develop menu when debugging the shell.
        if ProcessInfo.processInfo.environment["RA2_INSPECT"] == "1" {
            webView.isInspectable = true
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Red Alert 2"
        window.minSize = NSSize(width: 800, height: 600)
        window.collectionBehavior = [.fullScreenPrimary]
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
        installTrackpadMapping()
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: URL(string: "ra2app://app/index.html")!))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "exitApp", message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == BundleSchemeHandler.scheme,
              message.frameInfo.request.url?.host == "app" else { return }
        NSApp.terminate(nil)
    }

    // Preserve native secondary clicks. Command + primary click provides a
    // fallback without taking Control away from the game's force-attack orders.
    // Map the whole press/drag/release sequence even if Command is released first.
    private func installTrackpadMapping() {
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] event in
            guard let self, event.window === self.window, self.window.attachedSheet == nil else { return event }
            if event.type == .leftMouseDown {
                let point = self.webView.convert(event.locationInWindow, from: nil)
                self.commandClickActive = event.modifierFlags.contains(.command) && self.webView.bounds.contains(point)
            }
            guard self.commandClickActive else { return event }
            let mappedType: NSEvent.EventType
            switch event.type {
            case .leftMouseDown: mappedType = .rightMouseDown
            case .leftMouseDragged: mappedType = .rightMouseDragged
            default:
                mappedType = .rightMouseUp
                self.commandClickActive = false
            }
            return NSEvent.mouseEvent(with: mappedType, location: event.locationInWindow,
                modifierFlags: event.modifierFlags.subtracting(.command), timestamp: event.timestamp,
                windowNumber: event.windowNumber, context: nil, eventNumber: event.eventNumber,
                clickCount: event.clickCount, pressure: event.pressure) ?? event
        }
    }

    func applicationDidResignActive(_ notification: Notification) {
        commandClickActive = false
    }

    func applicationWillTerminate(_ notification: Notification) {
        multiplayer.stop()
        if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        multiplayer.stop()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.scheme == BundleSchemeHandler.scheme && url?.host == "app" ? .allow : .cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        multiplayer.stop()
        showError("The game process stopped. Quit and reopen the app to return to the menu. Unsaved progress may be lost.")
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Red Alert 2 could not continue"
        alert.informativeText = message
        alert.beginSheetModal(for: window)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
