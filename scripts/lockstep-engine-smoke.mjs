// Run with: bun scripts/lockstep-engine-smoke.mjs [ticks=150]
// Requires the asset-seeded dev server at http://127.0.0.1:4000 (?shell=1).
// Uses two actual Chromium engine instances, two deterministic bots, production
// LobbyClient/NetworkTurnManager and a real WebSocket GameServer. No OpenRA code.
import { chromium } from '../redalert2/node_modules/playwright-core/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { GameServer } from '../redalert2/src/network/server/GameServer.ts';
import { BunWsTransport } from '../redalert2/server/BunWsTransport.ts';

const targetTicks = Number(process.argv[2] ?? 150);
if (!Number.isInteger(targetTicks) || targetTicks < 100) throw new Error('Use at least 100 ticks.');
const base = process.env.RA2_DEV_URL || 'http://127.0.0.1:4000';
const identity = { protocol: 2, ordersProtocol: 2, engine: 'ra2', mod: 'smoke', version: 'engine-smoke', modHash: 'same-rules', assetFingerprint: 'same-seeded-vfs' };
let core;
const transport = new BunWsTransport(0, '127.0.0.1');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', args: ['--disable-dev-shm-usage'] });
const errors = [];
let timer;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => { errors.push({ client: i, message: error.message }); console.error(`[client ${i}]`, error.message); });
    await page.goto(`${base}/?shell=1`);
    await page.waitForFunction(() => window.__ra2debug?.keyBinds, undefined, { timeout: 300000 });
    await page.getByText('Skirmish', { exact: true }).click();
    await page.waitForFunction(() => window.__ra2debug?.skirmishLobby?.gameOpts, undefined, { timeout: 120000 });
    console.log(`Client ${i + 1}: assets loaded and skirmish ready`);
  }
  const gameOpts = await pages[0].evaluate(async () => {
    const screen = window.__ra2debug.mainMenuController.getCurrentScreen();
    const { Engine } = await import('/src/engine/Engine.ts');
    const entry = screen.mapList.getAll().filter(map => map.official && map.maxSlots >= 4 && Engine.vfs.fileExists(map.fileName)).sort((a, b) => a.fileName.localeCompare(b.fileName))[0];
    if (!entry) throw new Error('No official map with four slots in the VFS.');
    screen.pregameController.applyMapSelection({ gameMode: screen.gameModes.getById(screen.pregameController.getGameOpts().gameMode), mapName: entry.fileName, changedMapFile: await Engine.vfs.openFileWithRfs(entry.fileName) });
    const opts = screen.pregameController.getGameOpts();
    const c = await import('/src/game/gameopts/constants.ts');
    opts.aiPlayers = Array.from({ length: opts.maxSlots }, (_, index) => index === 2 || index === 3 ? { difficulty: index === 2 ? 0 : 2, countryId: c.RANDOM_COUNTRY_ID, colorId: c.RANDOM_COLOR_ID, startPos: c.RANDOM_START_POS, teamId: c.NO_TEAM_ID } : undefined);
    return opts;
  });
  core = new GameServer({ identity, gameOpts, slotsInfo: Array.from({ length: gameOpts.maxSlots }, (_, i) => ({ type: i === 2 || i === 3 ? 4 : i < 2 ? 1 : 0 })), orderLatency: 2, now: Date.now, random: () => 0.125 }, transport);
  await core.start();
  timer = setInterval(() => core.tick(), 1000);
  for (let i = 0; i < 2; i++) {
    await pages[i].evaluate(async ({ address, identity, index, targetTicks }) => {
      const { LobbyClient } = await import('/src/network/client/LobbyClient.ts');
      const { NetworkTurnManager } = await import('/src/network/client/NetworkTurnManager.ts');
      const original = NetworkTurnManager.prototype.doGameTurn;
      window.__networkSmoke = { hashes: [], cap: targetTicks, errors: [], inject: false };
      NetworkTurnManager.prototype.doGameTurn = function (timestamp) {
        const probe = window.__networkSmoke;
        if (this.game.currentTick >= probe.cap) return false;
        if (probe.inject) { this.game.prng.generateRandom(); probe.inject = false; }
        const advanced = original.call(this, timestamp);
        if (advanced) probe.hashes.push({ tick: this.game.currentTick, hash: this.game.getHash() });
        return advanced;
      };
      const client = window.__networkSmoke.client = new LobbyClient();
      client.onError.subscribe(error => window.__networkSmoke.errors.push({ code: error.code, message: error.message }));
      client.onStartGame.subscribe(() => {
        const screen = window.__ra2debug.mainMenuController.getCurrentScreen();
        const match = client.getMatchSession();
        screen.rootController.goToScreen(1, { create: true, lanLaunch: match.getLaunchDescriptor(), lanMatchSession: match });
      });
      await client.connect(address, { ...identity, type: 'hello', name: `Smoke ${index + 1}` });
      client.command('map_ready', { digest: client.session.gameOpts.mapDigest });
      if (index === 1) client.command('state', { ready: true, mapDigest: client.session.gameOpts.mapDigest });
    }, { address: `127.0.0.1:${transport.port}`, identity, index: i, targetTicks });
  }
  await pages[0].waitForFunction(() => window.__networkSmoke.client.session.clients.length === 2 && window.__networkSmoke.client.session.clients.every(client => client.mapReady) && window.__networkSmoke.client.session.clients[1].ready);
  await pages[0].evaluate(() => window.__networkSmoke.client.command('startgame'));
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug?.game && window.__ra2debug?.gameScreen?.gameTurnMgr, undefined, { timeout: 180000 })));
  if (process.env.RA2_GAME_UI_SMOKE) await (await import('./game-hud-smoke.mjs')).checkGameHud(pages);
  await Promise.all(pages.map(page => page.evaluate(() => {
    const screen = window.__ra2debug.gameScreen;
    screen.gameAnimationLoop.stop();
    window.__networkSmoke.driver = setInterval(() => {
      for (let i = 0; i < 8; i++) if (!screen.gameTurnMgr.doGameTurn(performance.now())) break;
    }, 4);
  })));
  await Promise.all(pages.map(page => page.waitForFunction(ticks => window.__ra2debug?.game?.currentTick >= ticks, targetTicks, { timeout: 180000 })));
  const matching = await Promise.all(pages.map(page => page.evaluate(() => ({ hashes: window.__networkSmoke.hashes, errors: window.__networkSmoke.errors, objects: window.__ra2debug.game.world.getAllObjects().length, bots: window.__ra2debug.game.gameOpts.aiPlayers.filter(Boolean).length }))));
  if (matching.some(result => result.hashes.length !== targetTicks)) throw new Error('Turn instrumentation did not capture every tick. Run against a fresh dev server after source changes.');
  if (JSON.stringify(matching[0].hashes) !== JSON.stringify(matching[1].hashes)) throw new Error('Real engine hashes diverged before fault injection.');
  console.log(`Both clients match every frame through ${targetTicks} ticks, bots=${matching[0].bots}, objects=${matching[0].objects}`);
  await pages[1].evaluate(() => { window.__networkSmoke.inject = true; });
  await Promise.all(pages.map(page => page.evaluate(ticks => { window.__networkSmoke.cap = ticks + 10; }, targetTicks)));
  try {
    await Promise.all(pages.map(page => page.waitForFunction(() => window.__RA2_NETWORK_SYNC_REPORT__, undefined, { timeout: 30000 })));
  } catch (error) {
    console.error('Mismatch diagnostics', await Promise.all(pages.map(page => page.evaluate(() => ({ tick: window.__ra2debug.game.currentTick, fatal: window.__networkSmoke.client.getMatchSession().fatalError, errorState: window.__ra2debug.gameScreen.gameTurnMgr.getErrorState(), report: window.__RA2_NETWORK_SYNC_REPORT__?.message, errors: window.__networkSmoke.errors })))));
    throw error;
  }
  const reports = await Promise.all(pages.map(page => page.evaluate(() => { const report = window.__RA2_NETWORK_SYNC_REPORT__; return { frame: report.frame, tick: report.tick, stateTick: report.state.currentTick, errors: window.__networkSmoke.errors }; })));
  if (reports.some(report => report.frame !== targetTicks + 1)) throw new Error(`Wrong mismatch frame: ${JSON.stringify(reports)}`);
  if (errors.length || matching.some(result => result.errors.length) || reports.some(report => report.errors.length)) throw new Error(`Unexpected errors: ${JSON.stringify({ errors, matching: matching.map(result => result.errors), reports })}`);
  // Load the production turn manager in the browser, where the engine's module
  // initialization order is supported, and reproduce shutdown inside update().
  await pages[0].evaluate(async () => {
    const { NetworkTurnManager } = await import('/src/network/client/NetworkTurnManager.ts');
    const { NetworkMatchSession } = await import('/src/network/client/NetworkMatchSession.ts');
    const { EventDispatcher } = await import('/src/util/event.ts');
    const { encodeOrderPacket } = await import('/src/network/server/Protocol.ts');
    const original = window.__networkSmoke.client.getMatchSession();
    let closed = false;
    let sent = 0;
    const connection = {
      onMessage: new EventDispatcher(), onClose: new EventDispatcher(),
      sendRaw() { if (closed) throw new Error('Not connected to the game server.'); sent++; },
      close() { closed = true; },
    };
    const match = new NetworkMatchSession(connection, original.start, original.descriptor);
    connection.onMessage.dispatch(connection, JSON.stringify({ type: 'allLoaded' }));
    for (const id of original.start.clientIds) connection.onMessage.dispatch(connection, encodeOrderPacket(id, 1, new Uint8Array()));
    const game = { currentTick: 0, speed: { value: 1 }, getHash: () => 123, getPlayerByName: name => ({ name }),
      update() { manager.setErrorState(); match.leaveRoom(); },
      debugGetState() { throw new Error('Deliberately failed diagnostic snapshot'); },
    };
    const manager = new NetworkTurnManager(game, {}, { dequeueAll: () => [] }, {}, match);
    manager.init();
    if (!manager.doGameTurn(0) || sent !== 1 || match.fatalError) throw new Error('Game-end shutdown regression');
    let reported;
    manager.onFatalError.subscribe(error => { reported = error.message; });
    match.fail('Original connection failure');
    if (reported !== 'Original connection failure') throw new Error('Diagnostics masked the original error');
    manager.dispose();
  });
  console.log('Game-end shutdown and failed diagnostic export regressions passed');
  mkdirSync('build', { recursive: true });
  writeFileSync('build/lockstep-engine-smoke.json', JSON.stringify({ targetTicks, map: gameOpts.mapName, orderLatency: 2, clients: matching, divergence: reports }, null, 2));
  console.log(`Injected PRNG divergence stopped both clients; mismatch frame=${reports[0].frame}, stopped ticks=${reports.map(report => report.tick).join('/')}. Report: build/lockstep-engine-smoke.json`);
} finally {
  clearInterval(timer); core?.stop(); transport.close(); await browser.close();
}
