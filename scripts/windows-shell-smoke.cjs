#!/usr/bin/env node
'use strict';

// Dependency-free shell contract checks. These execute the production shell in
// a VM with Electron APIs mocked; they do not replace a Windows launch test.
// Usage: node scripts/windows-shell-smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'linux/main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'linux/preload.js'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra2-windows-shell-'));

async function checkShell({ name, platform, layout, variant = 'yr', override = false }) {
    const fixture = path.join(temp, name);
    const runtimeResources = path.join(fixture, 'resources');
    const appDir = layout === 'packaged' ? path.join(runtimeResources, 'app')
        : path.join(fixture, 'staged', 'app');
    const defaultResources = layout === 'staged' ? path.join(appDir, '..', 'Resources')
        : path.join(runtimeResources, 'Resources');
    const resources = override ? path.join(fixture, 'override-resources') : defaultResources;
    const appName = variant === 'yr' ? "Yuri's Revenge" : 'Red Alert 2';
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify({ name: appName, variant, version: '1.2.3' }));
    for (const resourceDir of new Set([defaultResources, resources])) {
        fs.mkdirSync(path.join(resourceDir, 'WebDist'), { recursive: true });
        fs.mkdirSync(path.join(resourceDir, 'GameRes'), { recursive: true });
        fs.writeFileSync(path.join(resourceDir, 'WebDist', 'index.html'), resourceDir === resources ? name : 'wrong resources');
        fs.writeFileSync(path.join(resourceDir, 'GameRes', 'test.mix'), 'streamed game content');
    }

    let windowOptions, loadedUrl, protocolHandler, ready;
    const settings = {}, switches = [], streamedFiles = [], sent = [];
    const electron = {
        app: {
            commandLine: { appendSwitch: (...args) => switches.push(args) },
            on() {}, whenReady: () => ({ then: (callback) => { ready = callback; } }),
            getPath: () => path.join(fixture, 'AppData'),
            setPath: (key, value) => {
                // Real Electron requires the directory to exist on first launch.
                assert.ok(fs.statSync(value).isDirectory());
                settings[key] = value;
            },
            setAppUserModelId: (value) => { settings.appId = value; },
        },
        ipcMain: { handle() {}, on() {} },
        protocol: { registerSchemesAsPrivileged() {}, handle: (_scheme, handler) => { protocolHandler = handler; } },
        Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
        BrowserWindow: class {
            constructor(options) {
                windowOptions = options;
                this.webContents = { setWindowOpenHandler() {}, on() {} };
            }
            setTitle() {}
            on() {}
            loadURL(url) { loadedUrl = url; }
        },
    };
    const fsProxy = {
        ...fs,
        readFileSync(file, ...args) {
            assert.equal(path.basename(file), 'app.json', 'Game assets must stream rather than buffer in main');
            return fs.readFileSync(file, ...args);
        },
        createReadStream(file) { streamedFiles.push(file); return fs.createReadStream(file); },
    };
    const context = vm.createContext({
        require: (id) => id === 'electron' ? electron : id === 'fs' ? fsProxy : require(id),
        __dirname: appDir,
        process: { platform, resourcesPath: runtimeResources, env: override ? { RA2_RESOURCES: resources } : {}, argv: [] },
        URL, Response,
    });
    vm.runInContext(mainSource, context, { filename: 'linux/main.js' });
    ready();
    assert.equal(loadedUrl, 'ra2app://app/index.html');
    assert.equal(windowOptions.webPreferences.sandbox, true);
    assert.equal(windowOptions.webPreferences.contextIsolation, true);
    assert.equal(windowOptions.webPreferences.nodeIntegration, false);
    assert.equal(windowOptions.fullscreen, false);
    assert.equal(switches.length, platform === 'linux' ? 1 : 0);
    if (platform === 'win32') {
        assert.equal(settings.userData, path.join(fixture, 'AppData', appName));
        assert.equal(settings.appId, `com.redalert2.desktop.${variant}`);
    } else {
        assert.equal(settings.userData, undefined, 'Existing Linux storage must be preserved');
    }

    const index = protocolHandler({ url: 'ra2app://app/' });
    assert.equal(await index.text(), name);
    assert.equal(index.headers.get('Content-Type'), 'text/html');
    assert.equal(index.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
    assert.equal(index.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
    const asset = protocolHandler({ url: 'ra2app://app/gameres/test.mix?v=1' });
    assert.equal(await asset.text(), 'streamed game content');
    assert.equal(asset.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(Number(asset.headers.get('Content-Length')), Buffer.byteLength('streamed game content'));
    assert.deepEqual(streamedFiles, [path.join(resources, 'WebDist', 'index.html'), path.join(resources, 'GameRes', 'test.mix')]);

    for (const url of [
        'ra2app://app/%2e%2e%5coutside',
        'ra2app://app/gameres/%2e%2e%2foutside',
        'ra2app://app/test.mix%3Asecret',
        'ra2app://app/%00',
        'ra2app://elsewhere/index.html',
        'https://app/index.html',
    ]) assert.equal(protocolHandler({ url }).status, 403, url);
    for (const url of ['ra2app://app/%ZZ', 'not a URL']) {
        assert.equal(protocolHandler({ url }).status, 400, url);
    }
    assert.equal(protocolHandler({ url: 'ra2app://app/missing' }).status, 404);
    assert.equal(protocolHandler({ url: 'ra2app://app/gameres/' }).status, 404);
    assert.equal(streamedFiles.length, 2, 'Rejected URLs must not open streams');

    let bridge;
    const preloadContext = vm.createContext({
        require: () => ({
            contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, '__RA2_SHELL__'); bridge = value; } },
            ipcRenderer: { send: (...args) => sent.push(args), invoke: (...args) => sent.push(args) },
        }),
        process: { argv: windowOptions.webPreferences.additionalArguments },
    });
    vm.runInContext(preloadSource, preloadContext, { filename: 'linux/preload.js' });
    assert.equal(bridge.platform, platform === 'win32' ? 'windows' : 'linux');
    assert.equal(bridge.version, '1.2.3');
    assert.equal(Object.isFrozen(bridge), true);
    bridge.exitApp();
    bridge.hostGame({ port: 4567 });
    bridge.stopHosting();
    assert.deepEqual(sent, [['ra2:exit'], ['ra2:host-game', { port: 4567 }], ['ra2:stop-hosting']]);
    console.log(`PASS ${name}`);
}

(async () => {
    try {
        for (const fixture of [
            { name: 'Windows packaged YR', platform: 'win32', layout: 'packaged' },
            { name: 'Windows packaged RA2', platform: 'win32', layout: 'packaged', variant: 'ra2' },
            { name: 'Runtime resources outside application folder', platform: 'win32', layout: 'external' },
            { name: 'Linux staged resources', platform: 'linux', layout: 'staged' },
            { name: 'Explicit resources override', platform: 'win32', layout: 'packaged', override: true },
        ]) await checkShell(fixture);
        console.log('Shell contract smoke passed (mocked Electron; Windows runtime testing still required).');
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
