'use strict';
// Runs in the isolated world before any page script. The engine reads
// window.__RA2_SHELL__ for native-shell detection and `.platform` (see
// redalert2/src/shell/iosSeed.ts and src/engine/PowerState.ts), which is what
// switches on the native-shell boot path: first-launch asset seeding from
// /gameres/, no CRC pass, focused main menu, no browser fullscreen toggle.
//
// Sandboxed preloads cannot require fs, so main.js hands the version over as
// an extra process argument.
const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--ra2-shell-version='));
const version = arg ? arg.slice('--ra2-shell-version='.length) : '0.1.0';

contextBridge.exposeInMainWorld('__RA2_SHELL__', Object.freeze({
    platform: 'linux',
    version,
    // Main-menu Exit button (redalert2/src/gui/screen/mainMenu/main/HomeScreen.ts).
    exitApp: () => ipcRenderer.send('ra2:exit'),
    hostGame: (options) => ipcRenderer.invoke('ra2:host-game', options),
    stopHosting: () => ipcRenderer.invoke('ra2:stop-hosting'),
}));
