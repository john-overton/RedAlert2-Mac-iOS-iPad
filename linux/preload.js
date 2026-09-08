'use strict';
// Runs in the isolated world before any page script. The engine only reads
// window.__RA2_SHELL__ for truthiness and `.platform` (see
// redalert2/src/shell/iosSeed.ts and src/engine/PowerState.ts), which is what
// switches on the native-shell boot path: first-launch asset seeding from
// /gameres/, no CRC pass, focused main menu, no browser fullscreen toggle.
//
// Sandboxed preloads cannot require fs, so main.js hands the version over as
// an extra process argument.
const { contextBridge } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--ra2-shell-version='));
const version = arg ? arg.slice('--ra2-shell-version='.length) : '0.1.0';

contextBridge.exposeInMainWorld('__RA2_SHELL__', Object.freeze({ platform: 'linux', version }));
