// Spike S3 of docs/MULTIPLAYER_PLAN.md: run the same seeded skirmish (human idle,
// three bots) headlessly in a browser engine and record game.getHash() every
// 100 ticks. Run it under Chromium (V8) and WebKit (JavaScriptCore) and diff
// the outputs; a lockstep multiplayer game can only work across those engines
// if every hash matches.
//
//   node scripts/determinism-cross-engine-smoke.mjs chromium 3000 build/hash-chromium.json
//   node scripts/determinism-cross-engine-smoke.mjs webkit   3000 build/hash-webkit.json
//   node scripts/determinism-cross-engine-smoke.mjs --compare build/hash-chromium.json build/hash-webkit.json
//
// Needs the dev server (cd redalert2 && RA2_HTTP=1 bun run dev) and, for WebKit,
// `node redalert2/node_modules/playwright-core/cli.js install webkit`.
import {chromium, webkit} from '../redalert2/node_modules/playwright-core/index.mjs';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';

if (process.argv[2] === '--compare') {
  const [a, b] = process.argv.slice(3).map(f => JSON.parse(readFileSync(f, 'utf8')));
  console.log(`A: ${a.engine}  B: ${b.engine}  map=${a.mapName} seed=${a.gameId}/${a.timestamp}`);
  if (a.mapName !== b.mapName || a.timestamp !== b.timestamp) throw new Error('Runs used different games; nothing to compare');
  let first = null;
  for (let i = 0; i < Math.min(a.hashes.length, b.hashes.length); i++) {
    if (a.hashes[i].hash !== b.hashes[i].hash) { first = a.hashes[i].tick; break; }
  }
  const n = Math.min(a.hashes.length, b.hashes.length);
  console.log(first === null ? `IDENTICAL: all ${n} checkpoints match (through tick ${a.hashes[n-1].tick})` : `DIVERGED at tick ${first} (matched ${a.hashes.findIndex(h => h.tick === first)} checkpoints before it)`);
  console.log(`getHash cost: A ${a.hashMs.toFixed(2)} ms  B ${b.hashMs.toFixed(2)} ms   sim: A ${a.msPerTick.toFixed(2)} ms/tick  B ${b.msPerTick.toFixed(2)} ms/tick   objects: A ${a.objects} B ${b.objects}`);
  process.exit(first === null ? 0 : 2);
}

const engine = process.argv[2] ?? 'chromium';
const ticks = Number(process.argv[3] ?? 3000);
const outFile = process.argv[4] ?? `build/hash-${engine}.json`;
const GAME_ID = 'spike-s3';
const TIMESTAMP = 1757000000000; // fixed seed, whole seconds so it round-trips the replay format
const launcher = engine === 'webkit' ? webkit : chromium;
const launchOpts = engine === 'webkit' ? {} : {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium'};
// WebKit keeps a persistent profile so the IndexedDB-backed asset seed survives between runs.
const browser = engine === 'webkit'
  ? await launcher.launchPersistentContext(process.env.RA2_WEBKIT_PROFILE || 'build/webkit-profile', {headless: true, viewport: {width: 1280, height: 900}})
  : await launcher.launch({headless: true, ...launchOpts});
try {
  const page = engine === 'webkit' ? await browser.newPage() : await browser.newPage({viewport: {width: 1280, height: 900}});
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('[pageerror]', e.message); });
  page.on('response', r => { const ct = r.headers()['content-type'] || ''; if (ct.includes('text/html') && !/\/(\?.*)?$|\.html/.test(r.url())) console.error('[html-fallback]', r.url()); });
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text().slice(0, 300)); });
  if (engine === 'webkit') {
    // Playwright's Linux WebKit build has no Origin Private File System; back the shell's
    // asset seed with the file-system-access ponyfill's IndexedDB adapter (Vite serves it).
    await page.addInitScript((base) => {
      if (navigator.storage?.getDirectory) return;
      // import() is refused from Playwright's injected-script context in WebKit, so load the
      // ponyfill through a real module <script> and have getDirectory() wait for it.
      const inject = () => {
        const script = document.createElement('script');
        script.type = 'module';
        script.textContent = `import {getOriginPrivateDirectory} from '${base}/node_modules/file-system-access/lib/getOriginPrivateDirectory.js';` +
          `import indexeddb from '${base}/node_modules/file-system-access/lib/adapters/indexeddb.js';` +
          'window.__opfsRoot = getOriginPrivateDirectory(indexeddb);';
        document.documentElement.appendChild(script);
      };
      if (document.documentElement) inject(); else document.addEventListener('readystatechange', inject, {once: true});
      const storage = navigator.storage ?? {};
      storage.getDirectory = async () => { while (!window.__opfsRoot) await new Promise(r => setTimeout(r, 25)); return window.__opfsRoot; };
      storage.estimate ??= async () => ({usage: 0, quota: 8e9});
      storage.persist ??= async () => true;
      storage.persisted ??= async () => true;
      Object.defineProperty(navigator, 'storage', {value: storage, configurable: true});
      window.__opfsPolyfill = 'file-system-access indexeddb adapter';
    }, 'http://127.0.0.1:4000');
    // The menu video's MediaSource fallback aborts WPE's GStreamer web process; media is irrelevant to the sim.
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      HTMLMediaElement.prototype.load = function () {};
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {set() {}, get() { return ''; }, configurable: true});
    });
  }
  await page.goto('http://127.0.0.1:4000/?shell=1');
  await page.waitForFunction(() => window.__ra2debug?.keyBinds, undefined, {timeout: 300000});
  console.log(`[${engine}] menu up:`, await page.evaluate(() => navigator.userAgent));
  await page.getByText('Skirmish', {exact: true}).click();
  await page.waitForFunction(() => window.__ra2debug?.skirmishLobby?.gameOpts, undefined, {timeout: 120000});
  const setup = await page.evaluate(async ({gameId, timestamp}) => {
    const d = window.__ra2debug;
    const screen = d.mainMenuController.getCurrentScreen();
    const pc = screen.pregameController;
    // Deterministic map choice: first official map (by file name) with at least four start positions.
    const {Engine} = await import('/src/engine/Engine.ts');
    // The map list also names CDN-only maps that are not in the shipped archives; keep to what the VFS can open.
    const entry = screen.mapList.getAll().filter(m => m.official && m.maxSlots >= 4 && Engine.vfs.fileExists(m.fileName)).sort((a, b) => a.fileName.localeCompare(b.fileName))[0];
    if (!entry) throw new Error('No official map with 4+ slots in the VFS');
    const mapFile = await Engine.vfs.openFileWithRfs(entry.fileName);
    pc.applyMapSelection({gameMode: screen.gameModes.getById(pc.getGameOpts().gameMode), mapName: entry.fileName, changedMapFile: mapFile});
    const opts = pc.getGameOpts();
    const c = await import('/src/game/gameopts/constants.ts');
    const ai = difficulty => ({difficulty, countryId: c.RANDOM_COUNTRY_ID, colorId: c.RANDOM_COLOR_ID, startPos: c.RANDOM_START_POS, teamId: c.NO_TEAM_ID});
    const botCount = Math.min(3, opts.maxSlots - 1);
    opts.aiPlayers = opts.aiPlayers.map(() => undefined);
    while (opts.aiPlayers.length < botCount) opts.aiPlayers.push(undefined);
    [0, 4, 2].slice(0, botCount).forEach((diff, i) => { opts.aiPlayers[i] = ai(diff); });
    opts.humanPlayers[0] = {...opts.humanPlayers[0], countryId: c.RANDOM_COUNTRY_ID, colorId: c.RANDOM_COLOR_ID, startPos: c.RANDOM_START_POS, teamId: c.NO_TEAM_ID};
    screen.rootController.createGame(gameId, timestamp, '', screen.playerName, opts, true, false, false, false, undefined);
    return {mapName: opts.mapName, mapTitle: opts.mapTitle, maxSlots: opts.maxSlots, ais: opts.aiPlayers.filter(Boolean).length, gameMode: opts.gameMode, gameSpeed: opts.gameSpeed};
  }, {gameId: GAME_ID, timestamp: TIMESTAMP});
  console.log(`[${engine}] starting`, JSON.stringify(setup));
  await page.waitForFunction(() => window.__ra2debug?.game && window.__ra2debug?.gameScreen?.gameTurnMgr, undefined, {timeout: 600000});
  const result = await page.evaluate(({ticks}) => {
    const d = window.__ra2debug, g = d.game, s = d.gameScreen;
    s.gameAnimationLoop.stop();
    const hashes = [{tick: g.currentTick, hash: g.getHash()}];
    const t0 = performance.now();
    while (g.currentTick < ticks) {
      s.gameTurnMgr.doGameTurn(performance.now());
      if (g.currentTick % 100 === 0) hashes.push({tick: g.currentTick, hash: g.getHash()});
    }
    const simMs = performance.now() - t0;
    const h0 = performance.now(); for (let i = 0; i < 20; i++) g.getHash(); const hashMs = (performance.now() - h0) / 20;
    const players = g.getAllPlayers?.().map(p => ({name: p.name, country: p.country?.name, defeated: p.defeated})) ?? [];
    return {tick: g.currentTick, hashes, msPerTick: simMs / ticks, hashMs, objects: g.world.getAllObjects().length, players, lastRandom: g.prng.getLastRandom()};
  }, {ticks});
  const out = {engine, ua: await page.evaluate(() => navigator.userAgent), gameId: GAME_ID, timestamp: TIMESTAMP, ...setup, ...result, errors};
  mkdirSync('build', {recursive: true});
  writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(`[${engine}] tick ${out.tick}: ${out.hashes.length} checkpoints, ${out.objects} objects, ${out.msPerTick.toFixed(2)} ms/tick, getHash ${out.hashMs.toFixed(2)} ms, final hash ${out.hashes.at(-1).hash} -> ${outFile}`);
  if (errors.length) { console.error(`[${engine}] ${errors.length} page error(s)`); process.exitCode = 1; }
} finally {
  await browser.close();
}
