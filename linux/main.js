'use strict';
// Shared Electron shell for the Linux and Windows builds. Mirrors the AppKit shell in
// macos/Sources/main.swift and the bundle scheme handler in
// ios/Sources/BundleSchemeHandler.swift: the built web app and the imported
// game assets are served from disk under the custom `ra2app://` scheme, so
// the engine never sees a network origin or a localhost server.
//
//   ra2app://app/<path>            -> <Resources>/WebDist/<path>
//   ra2app://app/gameres/<path>    -> <Resources>/GameRes/<path>
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { randomUUID } = require('crypto');

const SCHEME = 'ra2app';
const APP_DIR = __dirname;
const appInfo = readAppInfo();
const RESOURCES = process.env.RA2_RESOURCES
    || [
        // Packaged Electron apps (including app.asar) keep game files outside
        // the application archive. The Linux system-Electron launcher instead
        // stages app/ and Resources/ as siblings.
        process.resourcesPath && path.join(process.resourcesPath, 'Resources'),
        path.join(APP_DIR, '..', 'Resources'),
    ].find((candidate) => candidate && fs.existsSync(candidate))
    || path.join(APP_DIR, '..', 'Resources');
const WEB_ROOT = path.join(RESOURCES, 'WebDist');
const GAMERES_ROOT = path.join(RESOURCES, 'GameRes');
const ICON_PATH = path.join(RESOURCES, 'icon.png');

if (process.platform === 'win32') {
    // Keep classic and YR saves/preferences separate, and preserve them across
    // portable builds moved to another folder. Electron stores this in AppData.
    const userData = path.join(app.getPath('appData'), appInfo.name);
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
    app.setAppUserModelId(`com.redalert2.desktop.${appInfo.variant}`);
}

function readAppInfo() {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
    }
    catch {
        return { name: 'Red Alert 2', variant: 'yr', version: '0.1.0' };
    }
}

const MIME = {
    html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
    json: 'application/json', wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
    mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'video/webm', mp4: 'video/mp4',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    ini: 'application/octet-stream', csf: 'application/octet-stream', mix: 'application/octet-stream',
    map: 'application/octet-stream', mpr: 'application/octet-stream',
};
const mimeFor = (file) => MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

// Every response carries COOP/COEP so the app stays crossOriginIsolated
// (SharedArrayBuffer available), matching the headers the Vite dev server sets.
const baseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
};
const text = (status, body) => new Response(body, {
    status, headers: { ...baseHeaders, 'Content-Type': 'text/plain' },
});

function serve(request) {
    let url;
    try { url = new URL(request.url); }
    catch { return text(400, 'bad url'); }
    // URL parsing already drops the query string vite appends (?v=...).
    if (url.protocol !== `${SCHEME}:` || url.hostname !== 'app') return text(403, 'forbidden');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return text(400, 'bad url'); }
    if (pathname === '' || pathname === '/') pathname = '/index.html';
    const relative = pathname.replace(/^\/+/, '');
    // Reject traversal before touching the filesystem, exactly like the iOS handler.
    // Backslashes are filesystem separators on Windows, and ':' can address
    // NTFS alternate data streams. Neither is valid in a bundled asset URL.
    if (relative.includes('\\') || relative.includes(':') || relative.includes('\0')
        || relative.split('/').includes('..')) return text(403, 'forbidden');

    const file = relative.startsWith('gameres/')
        ? path.join(GAMERES_ROOT, relative.slice('gameres/'.length))
        : path.join(WEB_ROOT, relative);

    let stat;
    try { stat = fs.statSync(file); }
    catch { return text(404, `not found: ${relative}`); }
    if (!stat.isFile()) return text(404, `not found: ${relative}`);

    // Always stream: a 280 MB mix must never be buffered whole in the main process.
    const body = Readable.toWeb(fs.createReadStream(file));
    return new Response(body, {
        status: 200,
        headers: {
            ...baseHeaders,
            'Content-Type': mimeFor(file),
            'Content-Length': String(stat.size),
            'Cache-Control': 'no-cache',
        },
    });
}

protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}

let win;
let hostedGame;
let hostingPending = false;
function stopHosting() {
    hostedGame?.stop();
    hostedGame = undefined;
}
function assertAppFrame(event) {
    const frame = event.senderFrame;
    if (!frame || frame !== frame.top || !frame.url.startsWith(`${SCHEME}://app/`)) {
        throw new Error('Only the game window can manage a multiplayer server.');
    }
}
ipcMain.handle('ra2:host-game', async (event, options) => {
    assertAppFrame(event);
    if (hostedGame?.isStopped) stopHosting();
    if (hostingPending || hostedGame) throw new Error('A game is already being hosted. Leave it first.');
    hostingPending = true;
    try {
        const { hostGame } = require('./multiplayer.cjs');
        hostedGame = await hostGame(options);
        if (event.sender.isDestroyed()) { stopHosting(); throw new Error('Game window closed.'); }
        return { port: hostedGame.port, addresses: hostedGame.addresses };
    }
    finally { hostingPending = false; }
});
ipcMain.handle('ra2:stop-hosting', (event) => { assertAppFrame(event); stopHosting(); });

const MAX_PERFORMANCE_REPORT_BYTES = 16 * 1024 * 1024;
ipcMain.handle('ra2:save-performance-report', async (event, payload) => {
    const frame = event.senderFrame;
    if (!win || event.sender !== win.webContents || !frame || frame !== win.webContents.mainFrame
        || frame !== frame.top || !frame.url.startsWith(`${SCHEME}://app/`)) {
        throw new Error('Only the bundled game main frame can save a performance report.');
    }
    if (typeof payload !== 'string' || payload.length > MAX_PERFORMANCE_REPORT_BYTES
        || Buffer.byteLength(payload, 'utf8') > MAX_PERFORMANCE_REPORT_BYTES) {
        throw new Error('Performance report must be JSON text no larger than 16 MiB.');
    }
    let report;
    try { report = JSON.parse(payload); }
    catch { throw new Error('Performance report contains invalid JSON.'); }
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('Performance report must contain a JSON object.');
    }
    // Linux runs system Electron with <game>/app beside <game>/run.sh.
    // Windows bundles Electron as the game executable in the installation root.
    const gameDirectory = process.platform === 'win32' ? path.dirname(process.execPath) : path.resolve(APP_DIR, '..');
    const directory = path.join(gameDirectory, 'performance_logs');
    const filename = `performance-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    const destination = path.join(directory, filename);
    let created = false;
    let completed = false;
    try {
        await fs.promises.mkdir(directory, { recursive: true });
        // Exclusive creation works on portable FAT/exFAT drives as well as
        // NTFS/ext4. Never replace an existing report, even on a name collision.
        const handle = await fs.promises.open(destination, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(payload, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        completed = true;
        return { path: destination };
    }
    catch (error) {
        throw new Error(`Could not save performance report in ${directory}: ${error.code || error.message || error}. Check that the game folder is writable.`);
    }
    finally {
        if (created && !completed) await fs.promises.unlink(destination).catch(() => {});
    }
});
app.on('before-quit', stopHosting);

// Windowed by default like the Mac app. Tiling compositors (Hyprland) will
// otherwise squeeze the window below the engine's 800x600 minimum, so the
// launcher and desktop entry can opt into fullscreen with --fullscreen or
// RA2_FULLSCREEN=1; F11 still toggles at runtime.
const startFullscreen = process.env.RA2_FULLSCREEN === '1' || process.argv.includes('--fullscreen');

function createWindow() {
    win = new BrowserWindow({
        width: 1280, height: 800, minWidth: 800, minHeight: 600,
        fullscreen: startFullscreen,
        title: appInfo.name,
        backgroundColor: '#000000',
        autoHideMenuBar: true,
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
        webPreferences: {
            preload: path.join(APP_DIR, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
            // Menu music and the intro video autoplay, like the Mac shell's
            // mediaTypesRequiringUserActionForPlayback = [].
            autoplayPolicy: 'no-user-gesture-required',
            additionalArguments: [
                `--ra2-shell-version=${appInfo.version}`,
                `--ra2-shell-platform=${process.platform === 'win32' ? 'windows' : 'linux'}`,
            ],
        },
    });
    win.setTitle(appInfo.name);
    win.on('page-title-updated', (e) => e.preventDefault());

    // Single-window app: no popups, no navigation away from the bundled app.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(`${SCHEME}://`)) e.preventDefault();
    });
    win.webContents.on('render-process-gone', (_e, details) => {
        stopHosting();
        dialog.showMessageBox(win, {
            type: 'error',
            title: `${appInfo.name} could not continue`,
            message: `The game process stopped (${details.reason}). Quit and reopen the app to return to the menu. Unsaved progress may be lost.`,
        });
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
        if (isMainFrame) {
            dialog.showMessageBox(win, { type: 'error', title: `${appInfo.name} could not continue`, message: `${desc} (${code}) loading ${url}` });
        }
    });

    if (process.env.RA2_INSPECT === '1') win.webContents.openDevTools({ mode: 'detach' });
    win.loadURL(`${SCHEME}://app/index.html`);
}

function installMenu() {
    const menu = Menu.buildFromTemplate([
        {
            label: appInfo.name,
            submenu: [{ label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() }],
        },
        {
            label: 'View',
            submenu: [{
                label: 'Toggle Full Screen', accelerator: 'F11',
                click: () => { if (win) win.setFullScreen(!win.isFullScreen()); },
            }],
        },
    ]);
    Menu.setApplicationMenu(menu);
}

// The main menu's Exit button (the macOS shell's `exitApp` message handler).
// Only the bundled app's main frame may ask the shell to quit.
ipcMain.on('ra2:exit', (event) => {
    const frame = event.senderFrame;
    if (frame && frame === frame.top && frame.url.startsWith(`${SCHEME}://app/`)) app.quit();
});

app.whenReady().then(() => {
    protocol.handle(SCHEME, (request) => {
        try { return serve(request); }
        catch (err) { return text(500, String(err && err.message || err)); }
    });
    installMenu();
    createWindow();
});

app.on('window-all-closed', () => app.quit());
// Never open anything in an external browser from inside the game shell.
app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
