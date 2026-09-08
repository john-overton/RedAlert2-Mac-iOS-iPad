// node scripts/mass-unit-benchmark.mjs [config.json] [output.json]
// Build first: cd redalert2 && bun run build. Serves dist and local gameres-export.
import { chromium, webkit } from '../redalert2/node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, createReadStream, readdirSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';
if (['--compare', '--compare-subset'].includes(process.argv[2])) {
  const subset = process.argv[2] === '--compare-subset';
  const [before, after] = process.argv.slice(3).map(path => JSON.parse(readFileSync(path, 'utf8')));
  if (!before?.hashesMatch || !after?.hashesMatch) throw new Error('Both captures must be complete.');
  if (subset) {
    const withoutMatrix = c => { const { scenarios, counts, ...rest } = c; return rest; };
    const withoutCounts = c => { const { counts, ...rest } = c; return rest; };
    if (JSON.stringify(withoutMatrix(before.config)) !== JSON.stringify(withoutMatrix(after.config))) throw new Error('Non-matrix configuration differs.');
    const allowed = new Set();
    for (const scenario of after.config.scenarios) {
      const original = before.config.scenarios.find(s => s.name === scenario.name);
      if (!original || JSON.stringify(withoutCounts(original)) !== JSON.stringify(withoutCounts(scenario))) throw new Error('Scenario behavior differs.');
      for (const count of scenario.counts || after.config.counts) {
        if (!(original.counts || before.config.counts).includes(count)) throw new Error('Count absent from baseline.');
        for (const profiling of [false, true]) allowed.add(JSON.stringify([scenario.name, count, profiling]));
      }
    }
    before.runs = before.runs.filter(r => allowed.has(JSON.stringify([r.case, r.count, r.profiling])));
    const ordering = (a,b) => a.case.localeCompare(b.case) || a.count - b.count || Number(a.profiling) - Number(b.profiling) || (typeof a.sample === 'number' ? a.sample : a.sample === 'warmup' ? 0 : -1) - (typeof b.sample === 'number' ? b.sample : b.sample === 'warmup' ? 0 : -1);
    before.runs.sort(ordering); after.runs.sort(ordering);
  } else if (JSON.stringify(before.config) !== JSON.stringify(after.config)) throw new Error('Scenario configurations differ.');
  if (before.runs.length !== after.runs.length) throw new Error('Run counts differ.');
  for (let i = 0; i < before.runs.length; i++) {
    const a = before.runs[i], b = after.runs[i];
    if (a.case !== b.case || a.count !== b.count || a.profiling !== b.profiling || (!subset || typeof a.sample === 'number' || typeof b.sample === 'number' ? a.sample !== b.sample : false) || JSON.stringify(a.hashes) !== JSON.stringify(b.hashes)) throw new Error('Hash/run mismatch at sample ' + i);
  }
  const median = values => values.sort((a,b) => a-b)[Math.floor(values.length / 2)];
  const keys = [...new Set(before.runs.filter(r => typeof r.sample === 'number').map(r => JSON.stringify([r.case, r.count, r.profiling])))];
  for (const key of keys) {
    const subset = report => report.runs.filter(r => typeof r.sample === 'number' && JSON.stringify([r.case, r.count, r.profiling]) === key);
    const a = subset(before), b = subset(after);
    const values = kind => ({ beforeMs: median(a.map(r => r[kind].p95)), afterMs: median(b.map(r => r[kind].p95)) });
    console.log(JSON.stringify({ case: JSON.parse(key), orderP95: values('order'), tickP95: values('tick') }));
  }
  console.log('All simulation hashes match. Timings are medians of the measured repetitions; assess noise and runtime differences.');
  process.exit(0);
}
const config = JSON.parse(readFileSync(process.argv[2] || 'scripts/mass-unit-benchmark.json', 'utf8'));
const output = resolve(process.argv[3] || 'build/mass-unit-benchmark.json');
const requireConfig = (condition, message) => { if (!condition) throw new Error('Invalid benchmark configuration: ' + message); };
const coordinates = value => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger);
const validCounts = value => Array.isArray(value) && value.length > 0 && value.every(n => Number.isSafeInteger(n) && n > 0) && new Set(value).size === value.length;
requireConfig(config.render === undefined || typeof config.render === 'boolean', 'render must be boolean');
requireConfig(config.deviceScaleFactor === undefined || (Number.isFinite(config.deviceScaleFactor) && config.deviceScaleFactor >= 1 && config.deviceScaleFactor <= 3), 'deviceScaleFactor must be between 1 and 3');
requireConfig(Number.isInteger(config.repeats) && config.repeats >= 5, 'at least five measured repetitions are required');
requireConfig(Number.isSafeInteger(config.ticks) && config.ticks > 0, 'ticks must be positive');
requireConfig(validCounts(config.counts), 'counts must be distinct positive integers');
requireConfig(typeof config.map === 'string' && config.map.length > 0, 'map is required');
requireConfig(Number.isInteger(config.gameSpeed) && config.gameSpeed >= 0 && config.gameSpeed <= 6, 'gameSpeed must be 0–6');
requireConfig(Number.isSafeInteger(config.timestamp) && config.timestamp >= 0 && config.timestamp % 1000 === 0, 'timestamp must be a nonnegative whole-second millisecond value');
requireConfig(!config.origin || coordinates([config.origin.x, config.origin.y]), 'origin must have integer x/y coordinates');
requireConfig(Array.isArray(config.scenarios) && config.scenarios.length > 0, 'scenarios must be nonempty');
const names = new Set();
for (const scenario of config.scenarios) {
  requireConfig(typeof scenario.name === 'string' && scenario.name.length > 0 && !names.has(scenario.name), 'scenario names must be distinct and nonempty');
  names.add(scenario.name);
  requireConfig(!scenario.counts || validCounts(scenario.counts), 'invalid scenario counts');
  requireConfig(!scenario.selection || ['oversized-wire', 'batches'].includes(scenario.selection), 'unknown selection mode');
  requireConfig(Array.isArray(scenario.roster) && scenario.roster.length > 0 && scenario.roster.every(s => [1, 3, 7].includes(s.type) && typeof s.name === 'string' && s.name.length > 0), 'roster requires unit object types 1/3/7 and names');
  requireConfig(Array.isArray(scenario.commands), 'commands must be an array');
  const commandTicks = new Set();
  for (const command of scenario.commands) {
    requireConfig(Number.isInteger(command.tick) && command.tick >= 0 && command.tick < config.ticks && !commandTicks.has(command.tick), 'command ticks must be distinct and within the run');
    commandTicks.add(command.tick);
    requireConfig([0, 1, 2, 4, 11].includes(command.orderType), 'supported commands are move/force-move/attack-target/attack-move/stop (0/1/2/4/11)');
    requireConfig(command.orderType === 11 ? command.destination === undefined && command.targetIndex === undefined : command.orderType === 2 ? Number.isInteger(command.targetIndex) && command.targetIndex >= 0 && command.targetIndex < (scenario.targets?.length || 0) && command.destination === undefined : coordinates(command.destination), 'movement requires destination; attack requires targetIndex; stop has no target');
    requireConfig(command.queue === undefined || typeof command.queue === 'boolean', 'queue must be boolean');
  }
  requireConfig(scenario.targets === undefined || (Array.isArray(scenario.targets) && scenario.targets.every(s => [1, 3, 7].includes(s.type) && typeof s.name === 'string' && s.name.length > 0 && coordinates(s.offset))), 'targets require unit type/name and integer offsets relative to the first spawned unit');
  requireConfig(scenario.buildings === undefined || (Array.isArray(scenario.buildings) && scenario.buildings.every(s => typeof s.name === 'string' && s.name.length > 0 && coordinates(s.position))), 'invalid building fixture');
}
const engine = process.env.RA2_BENCH_ENGINE || 'chromium';
const cpuProfile = process.env.RA2_BENCH_CPU_PROFILE;
const stateDiagnostic = process.env.RA2_BENCH_STATE_DIAGNOSTIC === '1';
requireConfig(!cpuProfile || engine === 'chromium', 'CPU profiling requires Chromium');
requireConfig(['chromium', 'webkit'].includes(engine), 'RA2_BENCH_ENGINE must be chromium or webkit');
if (process.env.RA2_BENCH_URL) requireConfig(['http:', 'https:'].includes(new URL(process.env.RA2_BENCH_URL).protocol), 'RA2_BENCH_URL must use HTTP(S)');
const root = resolve(process.env.RA2_BENCH_DIST || 'redalert2/dist'), assets = resolve('gameres-export');
let server;
if (!process.env.RA2_BENCH_URL) {
  if (!existsSync(resolve(root, 'index.html'))) throw new Error('Missing production build: cd redalert2 && bun run build');
  server = createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
    const asset = pathname.startsWith('/gameres/');
    const base = asset ? assets : root;
    let file = resolve(base, '.' + (asset ? pathname.slice('/gameres'.length) : pathname));
    if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    if (file === root) file = resolve(root, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin' });
    createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  server.unref();
}
const url = process.env.RA2_BENCH_URL || `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
let browser;
let progressTimer;
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), buildIndexSha256: !process.env.RA2_BENCH_URL && existsSync(resolve(root, 'index.html')) ? createHash('sha256').update(readFileSync(resolve(root, 'index.html'))).digest('hex') : null, dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), buildMode: process.env.RA2_BENCH_URL ? 'external-unverified' : 'production', config, runtime: { engine, platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, memory: os.totalmem(), viewport: { width: 1280, height: 900 } }, limitations: ['Simulation-only: animation loop stopped; no frame/render/GPU or network latency conclusions.', 'Single commander, AI disabled; fixed fixture placement is measured, not the complete terrain/roster matrix.', 'Cold labels only the first fixture execution in the browser process. Engine loading and game initialization have already run; later cases share warmed JIT and asset caches. First/warmup samples are excluded from measured aggregates.', 'Ordinary selection uses SelectUnitsAction setter and caps at 128. The explicitly labeled oversized-wire fixture exercises the existing uncapped deserialization path.'], runs: [] };
// Fingerprint exact served build bytes separately from the source checkout at run time.
// This does not assert that a pre-existing dist was built from that checkout.
function fingerprintTree(directory) {
  const hash = createHash('sha256'); let files = 0;
  const visit = relative => {
    for (const entry of readdirSync(resolve(directory, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) { hash.update(name + '\0'); hash.update(readFileSync(resolve(directory, name))); hash.update('\0'); files++; }
      else throw new Error('Unsupported nonregular build artifact: ' + name);
    }
  };
  visit('');
  return { sha256: hash.digest('hex'), files };
}
if (config.render) report.limitations[0] = 'Controlled render probe: one simulation tick per RAF, camera follows first unit. Submit timings measure CPU submission, not GPU completion; RAF includes waiting and hash overhead. No network or production frame scheduler conclusions.';
report.provenance = {
  sourceCheckoutCommit: report.commit, sourceCheckoutDirty: report.dirty,
  sourceMatchesBuild: 'unverified; commit/dirty describe the checkout at capture time',
  servedBuild: process.env.RA2_BENCH_URL ? null : fingerprintTree(root),
  runnerSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  configSha256: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
  externalUrl: process.env.RA2_BENCH_URL || null,
};
function save() {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  const columns = ['case', 'count', 'profiling', 'sample', 'orderMedianMs', 'orderP95Ms', 'tickMedianMs', 'tickP95Ms', 'tickP99Ms', 'tickMaxMs', 'moved', 'selected'];
  const lines = report.runs.map(r => [r.case, r.count, r.profiling, r.sample, r.order.median, r.order.p95, r.tick.median, r.tick.p95, r.tick.p99, r.tick.max, r.moved, r.selected]);
  writeFileSync(output.replace(/\.json$/, '') + '.csv', [columns, ...lines].map(row => row.map(v => JSON.stringify(v ?? null)).join(',')).join('\n') + '\n');
}
try {
  report.runtime.deviceScaleFactor = config.deviceScaleFactor ?? 1;
  const contextOptions = { viewport: report.runtime.viewport, deviceScaleFactor: report.runtime.deviceScaleFactor };
  let context;
  if (engine === 'webkit') {
    context = await webkit.launchPersistentContext(process.env.RA2_WEBKIT_PROFILE || resolve('build/mass-unit-webkit-profile'), { headless: true, ...contextOptions });
    browser = context.browser();
    report.runtime.storageContext = 'persistent WebKit profile';
  } else {
    browser = await chromium.launch({ headless: true, executablePath });
    context = await browser.newContext(contextOptions);
    report.runtime.storageContext = 'ephemeral Chromium context';
  }
  report.runtime.browserVersion = browser.version();
  const page = await context.newPage();
  progressTimer = setInterval(async () => {
    const state = await page.evaluate(() => ({ menuReady: Boolean(window.__ra2debug?.keyBinds), gameTick: window.__ra2debug?.game?.currentTick, screen: window.__ra2debug?.mainMenuController?.getCurrentScreen()?.constructor.name, message: !window.__ra2debug?.game ? document.body.innerText.slice(-500) : undefined })).catch(e => ({ error: e.message }));
    console.log('[benchmark progress]', JSON.stringify(state));
  }, 30000);
  const cpuSession = cpuProfile ? await context.newCDPSession(page) : null;
  let capturedCpuProfile;
  if (cpuSession) {
    await cpuSession.send('Profiler.enable');
    await page.exposeFunction('__massStartCpuProfile', () => cpuSession.send('Profiler.start').then(() => undefined));
    await page.exposeFunction('__massStopCpuProfile', async () => { capturedCpuProfile = (await cpuSession.send('Profiler.stop')).profile; });
  }
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('[pageerror]', e.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('[browser]', message.text().slice(0, 500)); });
  page.on('response', response => { if (response.status() >= 400) console.error('[http]', response.status(), response.url()); });
  matrix: for (const scenario of config.scenarios) for (const count of (scenario.counts || config.counts)) {
    let reference;
    let caseStarted = false;
    for (const profiling of [false, true]) for (const sample of ['first', 'warmup', ...Array.from({ length: config.repeats }, (_, i) => i + 1)]) {
      if (!caseStarted) {
        await page.goto(url + '/?shell=1');
        caseStarted = true;
      } else {
        await page.evaluate(() => Promise.race([
          window.__massRoot.goToScreenBlocking(0),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out returning from completed game to menu')), 60000)),
        ]));
      }
      await page.waitForFunction(() => window.__ra2debug?.keyBinds, undefined, { timeout: 300000 });
      await page.getByText('Skirmish', { exact: true }).click();
      await page.waitForFunction(() => window.__ra2debug?.skirmishLobby?.gameOpts, undefined, { timeout: 120000 });
      await page.evaluate(async config => {
        const d = window.__ra2debug, s = d.mainMenuController.getCurrentScreen(), pc = s.pregameController;
        const map = s.mapList.getAll().find(m => m.fileName.toLowerCase() === config.map.toLowerCase());
        if (!map) throw new Error('Configured map absent: ' + config.map);
        pc.applyMapSelection({ gameMode: s.gameModes.getById(pc.getGameOpts().gameMode), mapName: map.fileName, changedMapFile: await s.mapFileLoader.load(map.fileName) });
        window.__massRoot = s.rootController;
        const opts = pc.getGameOpts();
        opts.aiPlayers = Array.from({ length: opts.maxSlots }, () => undefined);
        opts.unitCount = 0; opts.gameSpeed = config.gameSpeed; opts.cratesAppear = false;
        opts.humanPlayers[0] = { ...opts.humanPlayers[0], countryId: 0, colorId: 0, startPos: 0, teamId: -1 };
        s.rootController.createGame('mass-unit-benchmark', config.timestamp, '', s.playerName, opts, true, false, false, false, undefined);
      }, config);
      await page.waitForFunction(() => window.__ra2debug?.game && window.__ra2debug?.actionFactory && window.__ra2debug?.gameScreen?.gameTurnMgr, undefined, { timeout: 300000 });
      const result = await page.evaluate(async ({ config, scenario, count, profiling, captureCpuProfile, captureState }) => {
        const d = window.__ra2debug, g = d.game;
        d.gameScreen.gameAnimationLoop.stop();
        if (g.currentTick !== 0) throw new Error('Game advanced before fixture installation: ' + g.currentTick);
        const player = d.localPlayer;
        const units = [], used = new Set();
        // Explicit occupied endpoint fixture. The real building lifecycle invalidates terrain graphs.
        for (const spec of scenario.buildings || []) {
          const tile = g.map.tiles.getByMapCoords(...spec.position);
          if (!tile) throw new Error('Invalid building position');
          const building = g.createObject(2, spec.name);
          g.changeObjectOwner(building, player); g.spawnObject(building, tile);
        }
        const start = config.origin || g.map.startingLocations[player.startLocation];
        const tiles = g.map.tiles.getAll().slice().sort((a, b) => (Math.abs(a.rx - start.x) + Math.abs(a.ry - start.y)) - (Math.abs(b.rx - start.x) + Math.abs(b.ry - start.y)) || a.ry - b.ry || a.rx - b.rx);
        for (let i = 0; i < count; i++) {
          const spec = scenario.roster[i % scenario.roster.length];
          const unit = g.createObject(spec.type, spec.name);
          const tile = tiles.find(t => !used.has(t) && g.map.terrain.getPassableSpeed(t, unit.rules.speedType, false, false) > 0 && !g.map.tileOccupation.getObjectsOnTile(t).some(o => o.isUnit() || o.isBuilding()));
          if (!tile) throw new Error('No legal fixture spawn for ' + spec.name);
          used.add(tile); g.changeObjectOwner(unit, player); g.spawnObject(unit, tile); units.push(unit);
        }
        const targets = [];
        for (const spec of scenario.targets || []) {
          const target = g.createObject(spec.type, spec.name);
          const anchor = units[0].tile;
          const x = anchor.rx + spec.offset[0], y = anchor.ry + spec.offset[1];
          const candidates = g.map.tiles.getAll().slice().sort((a, b) => Math.abs(a.rx - x) + Math.abs(a.ry - y) - Math.abs(b.rx - x) - Math.abs(b.ry - y) || a.ry - b.ry || a.rx - b.rx);
          const tile = candidates.find(t => g.map.terrain.getPassableSpeed(t, target.rules.speedType, false, false) > 0 && !g.map.tileOccupation.getObjectsOnTile(t).some(o => o.isUnit() || o.isBuilding()));
          if (!tile) throw new Error('No legal target fixture spawn');
          g.changeObjectOwner(target, g.getCivilianPlayer()); g.spawnObject(target, tile);
          g.mapShroudTrait.getPlayerShroud(player).revealObject(target);
          targets.push(target);
        }
        if (targets.length) {
          const shroud = g.mapShroudTrait.getPlayerShroud(player);
          shroud.update();
          if (targets.some(t => shroud.isShrouded(t.tile, t.tileElevation))) throw new Error('Attack fixture target remained shrouded');
        }
        const initial = units.map(u => [u.tile.rx, u.tile.ry]);
        const selection = d.actionFactory.create(8); selection.player = player; selection.unitIds = units.map(u => u.id);
        if (scenario.selection === 'oversized-wire') {
          const bytes = new Uint8Array(units.length * 4), view = new DataView(bytes.buffer);
          units.forEach((u, i) => view.setUint32(i * 4, u.id, true));
          selection.unserialize(bytes);
        }
        selection.process();
        d.performance.setEnabled('telemetry', profiling); d.performance.reset();
        const orderTimes = [], tickTimes = [], hashes = [], hashTimes = [], orders = [];
        const renderUpdateTimes = [], renderSubmitTimes = [], frameIntervals = [], rafWaitTimes = [], drawCalls = [], renderFrames = [];
        let lastFrame;
        let graphics;
        if (config.render) {
          g.unitSelection.deselectAll(); units.forEach(u => g.unitSelection.addToSelection(u));
          d.worldInteraction.minimapHandler.panToTile(units[0].tile);
          const gl = d.renderer.renderer.getContext(), gpu = gl.getExtension('WEBGL_debug_renderer_info');
          const canvas = d.renderer.getCanvas();
          graphics = { canvasWidth: canvas.width, canvasHeight: canvas.height, devicePixelRatio: window.devicePixelRatio, renderer: gl.getParameter(gpu ? gpu.UNMASKED_RENDERER_WEBGL : gl.RENDERER), vendor: gl.getParameter(gpu ? gpu.UNMASKED_VENDOR_WEBGL : gl.VENDOR) };
        }
        const summary = values => {
          const sorted = values.slice().sort((a,b) => a-b), q = p => sorted[Math.max(0, Math.ceil(sorted.length * p)-1)] ?? 0;
          return { count: values.length, median: q(.5), p95: q(.95), p99: q(.99), max: q(1), above16_7: values.filter(v=>v>16.7).length, above33_3: values.filter(v=>v>33.3).length, above50: values.filter(v=>v>50).length };
        };
        const captureDiagnosticState = () => ({ tick: g.currentTick, hash: g.getHash(), lastRandom: g.prng.getLastRandom(), nextObjectId: g.nextObjectId.value,
          objects: g.world.getAllObjects().map(o => ({ id: o.id, name: o.name, constructorName: o.constructor.name, hash: o.getHash(), position: o.position.worldPosition.toArray(), positionBytes: [...new Uint8Array(new Float64Array(o.position.worldPosition.toArray()).buffer)], traits: o.traits.getAll().map(t => ({ name: t.constructor.name, hash: t.getHash?.() ?? 0 })) })),
          players: g.getAllPlayers().map(p => ({ name: p.name, hash: p.getHash() })), state: g.debugGetState() });
        const diagnosticStates = captureState ? [captureDiagnosticState()] : undefined;
        if (captureCpuProfile) await window.__massStartCpuProfile();
        for (let tick = 0; tick < config.ticks; tick++) {
          let orderMs = 0;
          const command = scenario.commands.find(c => c.tick === tick);
          if (command) {
            const batchSize = 128;
            const batches = scenario.selection === 'batches' ? Math.ceil(units.length / batchSize) : 1;
            const t = performance.now();
            for (let batch = 0; batch < batches; batch++) {
              if (scenario.selection === 'batches') {
                selection.unitIds = units.slice(batch * batchSize, (batch + 1) * batchSize).map(u => u.id);
                selection.process();
              }
              const action = d.actionFactory.create(9); action.player = player; action.orderType = command.orderType; action.queue = command.queue || false;
              if (command.targetIndex !== undefined) {
                const target = targets[command.targetIndex];
                action.target = g.createTarget(target, target.tile);
              } else if (command.destination) {
                const tile = g.map.tiles.getByMapCoords(...command.destination);
                if (!tile) throw new Error('Invalid destination ' + command.destination);
                action.target = g.createTarget(undefined, tile);
              }
              action.process();
            }
            const elapsed = performance.now() - t;
            orderMs = elapsed; orderTimes.push(elapsed); orders.push({ tick, elapsedMs: elapsed, batches });
          }
          const t = performance.now(); g.update(); tickTimes.push(performance.now() - t + orderMs);
          const hashAt = performance.now();
          const hash = g.getHash();
          hashTimes.push(performance.now() - hashAt);
          hashes.push({ tick: g.currentTick, hash });
          if (captureState && tick === 0) diagnosticStates.push(captureDiagnosticState());
          if (config.render) {
            if (d.renderer.isContextLost) throw new Error('WebGL context lost during render probe');
            const rafWaitAt = performance.now();
            const timestamp = await new Promise(resolve => requestAnimationFrame(resolve));
            rafWaitTimes.push(performance.now() - rafWaitAt);
            if (lastFrame !== undefined) frameIntervals.push(timestamp - lastFrame);
            lastFrame = timestamp;
            const updateAt = performance.now();
            d.worldInteraction.minimapHandler.panToTile(units[0].tile);
            d.renderer.update(timestamp, 1); renderUpdateTimes.push(performance.now() - updateAt);
            const info = d.renderer.renderer.info, autoReset = info.autoReset;
            info.autoReset = false; info.reset();
            try {
              const renderAt = performance.now(); d.renderer.render(); renderSubmitTimes.push(performance.now() - renderAt);
              drawCalls.push(info.render.calls);
              renderFrames.push({ tick: g.currentTick, updateMs: renderUpdateTimes.at(-1), submitMs: renderSubmitTimes.at(-1), hashMs: hashTimes.at(-1), simulationMs: tickTimes.at(-1), rafWaitMs: rafWaitTimes.at(-1), frameIntervalMs: tick === 0 ? null : frameIntervals.at(-1), drawCalls: info.render.calls });
            } finally { info.autoReset = autoReset; }
          }
        }
        if (captureCpuProfile) await window.__massStopCpuProfile();
        if (config.render && !drawCalls.some(count => count > 0)) throw new Error('Render probe submitted no draw calls');
        const { above16_7, above33_3, above50, ...drawSummary } = summary(drawCalls);
        const telemetry = d.performance.snapshot();
        const expectedAcceptedOrders = scenario.commands.length * (scenario.selection === 'batches' ? count : Math.min(count, 128));
        if (profiling && targets.length && units.every(u => !u.isDestroyed && !u.isDisposed) && telemetry.counters['order.accepted'] !== expectedAcceptedOrders) {
          throw new Error(`Expected ${expectedAcceptedOrders} accepted fixture orders, received ${telemetry.counters['order.accepted'] ?? 0}`);
        }
        return { diagnosticStates, render: config.render ? { frames: renderFrames, graphics, rafWait: summary(rafWaitTimes), update: summary(renderUpdateTimes), submit: summary(renderSubmitTimes), frameInterval: summary(frameIntervals), drawCalls: drawSummary, camera: 'follows first unit; camera pan included in update CPU time', pacing: 'one simulation tick per RAF; not production game-speed scheduling' } : null, order: summary(orderTimes), tick: summary(tickTimes), orders, tickTimes, hashes, hashTimes, hash: summary(hashTimes), selectionMode: scenario.selection || 'single-capped-selection', selected: scenario.selection === 'batches' ? units.length : selection.unitIds.length, moved: units.filter((u,i) => u.tile.rx !== initial[i][0] || u.tile.ry !== initial[i][1]).length, targets: targets.map(t => ({ id: t.id, name: t.name, x: t.tile.rx, y: t.tile.ry, health: t.healthTrait?.health, destroyed: t.isDestroyed })), initialPositions: initial, finalPositions: units.map(u => ({ id: u.id, x: u.tile.rx, y: u.tile.ry, destroyed: u.isDestroyed })), telemetry, expectedAcceptedOrders, normalTargetingDelay: g.rules.general.normalTargetingDelay, engineIdentity: { version: d.gameScreen.engineVersion, modHash: d.gameScreen.engineModHash }, map: g.gameOpts.mapName, gameSpeed: g.speed.value, tickBudgetMs: 1000 / (15 * g.speed.value), simulatedSeconds: config.ticks / (15 * g.speed.value), gameOptions: g.gameOpts, objectCount: g.world.getAllObjects().length, userAgent: navigator.userAgent, memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null };
      }, { config, scenario, count, profiling, captureCpuProfile: Boolean(cpuSession), captureState: stateDiagnostic });
      if (cpuSession) {
        mkdirSync(dirname(resolve(cpuProfile)), { recursive: true });
        writeFileSync(cpuProfile, JSON.stringify(capturedCpuProfile));
        report.cpuProfile = { path: cpuProfile, scope: 'one simulation loop including orders, updates and per-tick hashes; diagnostic timing includes profiler overhead' };
      }
      if (errors.length) throw new Error('Browser errors: ' + JSON.stringify(errors));
      const hashes = JSON.stringify(result.hashes);
      if (reference && reference !== hashes) throw new Error(`Determinism failure: ${scenario.name}/${count}/${profiling}/${sample}`);
      reference = hashes;
      report.runs.push({ case: scenario.name, count, profiling, sample: report.runs.length === 0 ? 'cold' : sample, ...result });
      save();
      console.log(`${scenario.name} n=${count} profiling=${profiling} ${sample}: order p95=${result.order.p95.toFixed(2)}ms tick p95=${result.tick.p95.toFixed(2)}ms moved=${result.moved}/${result.selected}`);
      if (cpuProfile || stateDiagnostic) break matrix;
    }
  }
  if (!process.env.RA2_BENCH_URL && fingerprintTree(root).sha256 !== report.provenance.servedBuild.sha256) throw new Error('Served build changed during capture.');
  report.completeMatrix = !(cpuProfile || stateDiagnostic);
  if (stateDiagnostic) report.diagnosticScope = 'first sample only; explicit initial and first-tick engine state capture; not a performance baseline';
  if (!cpuProfile && !stateDiagnostic) report.hashesMatch = true;
  save();
} finally { clearInterval(progressTimer); await browser?.close(); server?.close(); }
