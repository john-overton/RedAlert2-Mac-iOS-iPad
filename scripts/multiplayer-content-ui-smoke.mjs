// node scripts/multiplayer-content-ui-smoke.mjs
// Requires staged Linux YR Electron app and asset-seeded Vite on :4000.
// Retail-derived fixture files stay under ignored build/. Guest is a fresh context.
import { _electron as electron, chromium } from '../redalert2/node_modules/playwright-core/index.mjs';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createContentFixture, customUnitName, customMapName, customCameoName } from './multiplayer-content-fixture.mjs';
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'build/multiplayer-content-ui');
mkdirSync(output, { recursive: true });
const diagnostics = [];
let app, browser, host, guest;
function observe(page, name) {
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => diagnostics.push(`${name}: ${error.stack}`));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(`${name}: ${message.text()}`); });
}
async function waitLobby(page) {
    await page.waitForSelector('.multiplayer-lobby, .mp-error', { timeout: 180000 });
    if (!await page.locator('.multiplayer-lobby').count()) throw new Error(await page.locator('.mp-error').innerText());
}
async function verified(page) {
    await page.getByRole('status').filter({ hasText: 'Content verified: 4 files' }).waitFor({ timeout: 120000 });
}
async function stockState(page) {
    return page.evaluate(async ({ customUnitName, customMapName, customCameoName }) => {
        const { Engine } = await import('/src/engine/Engine.ts');
        return { unit: !!Engine.rules.getSection(customUnitName), map: Engine.vfs.fileExists(customMapName), cameo: Engine.vfs.fileExists(customCameoName), hash: Engine.modHash };
    }, { customUnitName, customMapName, customCameoName });
}
async function installProbe(page) {
    await page.evaluate(() => {
        const probe = window.__contentSmoke = { cap: 150, hashes: [] };
        probe.monitor = setInterval(() => {
            const screen = window.__ra2debug?.gameScreen;
            if (!screen?.gameTurnMgr || probe.manager === screen.gameTurnMgr) return;
            probe.manager = screen.gameTurnMgr;
            const original = probe.manager.doGameTurn;
            probe.manager.doGameTurn = function (timestamp) {
                if (this.game.currentTick >= probe.cap) return false;
                const advanced = original.call(this, timestamp);
                if (advanced) probe.hashes.push({ tick: this.game.currentTick, hash: this.game.getHash() });
                return advanced;
            };
        }, 1);
    });
}
async function advance(tick) {
    await Promise.all([host, guest].map(page => page.evaluate(tick => { window.__contentSmoke.cap = tick; }, tick)));
    await Promise.all([host, guest].map(page => page.waitForFunction(tick => window.__ra2debug?.game?.currentTick === tick, tick, { timeout: 180000 })));
    const states = await Promise.all([host, guest].map(page => page.evaluate(() => ({ tick: window.__ra2debug.game.currentTick, hash: window.__ra2debug.game.getHash(), fault: !!window.__RA2_NETWORK_SYNC_REPORT__ }))));
    assert.deepEqual(states[0], states[1]); assert.equal(states[0].fault, false);
}
try {
    app = await electron.launch({ executablePath: process.env.RA2_ELECTRON || '/usr/lib/electron43/electron', args: [resolve(root, 'build/linux/yr/app'), '--ozone-platform=wayland', `--user-data-dir=${mkdtempSync(resolve(output, 'host-profile-'))}`], timeout: 60000 });
    console.log('Electron attached.');
    host = await app.firstWindow(); observe(host, 'host');
    await host.getByText('Multiplayer', { exact: true }).waitFor({ timeout: 300000 });
    await host.getByText('Multiplayer', { exact: true }).click();
    await host.getByLabel('Player name', { exact: true }).fill('Content Host');
    await host.getByLabel('Port', { exact: true }).fill('19621');
    await host.locator('.multiplayer-entry button[type=submit]').first().click();
    await waitLobby(host);
    console.log('Host lobby ready.');
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true });
    guest = await browser.newPage({ viewport: { width: 1280, height: 900 } }); observe(guest, 'guest');
    await guest.goto(`${process.env.RA2_DEV_URL || 'http://127.0.0.1:4000'}/?shell=1`);
    await guest.getByText('Multiplayer', { exact: true }).waitFor({ timeout: 300000 });
    console.log('Fresh guest assets loaded.');
    const clean = await stockState(guest);
    assert.deepEqual({ ...clean, hash: undefined }, { unit: false, map: false, cameo: false, hash: undefined });
    const fixture = await guest.evaluate(async () => {
        const { Engine } = await import('/src/engine/Engine.ts');
        const maps = (await Engine.loadMapList()).getAll();
        const entry = maps.filter(map => map.official && map.maxSlots >= 4 && Engine.vfs.fileExists(map.fileName)).sort((a, b) => a.fileName.localeCompare(b.fileName))[0];
        if (!entry) throw new Error('No installed official four-player map.');
        return { map: (await Engine.vfs.openFileWithRfs(entry.fileName)).readAsString(), tankRules: Engine.rules.getSection('MTNK').toString() };
    });
    const files = createContentFixture(resolve(output, 'fixture'), fixture);
    await guest.getByText('Multiplayer', { exact: true }).click();
    await guest.getByLabel('Player name', { exact: true }).fill('Content Guest');
    await guest.getByLabel('Address', { exact: true }).fill('127.0.0.1:19621');
    await guest.locator('.multiplayer-entry button[type=submit]').last().click();
    await waitLobby(guest);
    console.log('Publishing content fixture.');
    await host.getByLabel('Host content files', { exact: true }).setInputFiles(files);
    await Promise.all([host, guest].map(verified));
    const loaded = await stockState(guest);
    assert.equal(loaded.unit, true); assert.equal(loaded.map, true); assert.equal(loaded.cameo, true);
    // Base installation identity stays stable; the content manifest gates readiness separately.
    assert.equal(loaded.hash, clean.hash);
    console.log('Clean guest received and mounted custom map, rules, art and original SHP cameo.');
    // Removal must invalidate readiness and restore all engine/VFS content immediately.
    await guest.locator('.mp-ready-bar button').click();
    await guest.getByText('Ready for battle', { exact: true }).waitFor();
    await host.getByText('Remove Content', { exact: true }).click();
    await guest.getByRole('status').filter({ hasText: 'Content verified: 0 files' }).waitFor();
    assert.deepEqual(await stockState(guest), clean);
    assert.equal(await guest.getByText('Ready for battle', { exact: true }).count(), 0);
    console.log('Publishing content fixture.');
    await host.getByLabel('Host content files', { exact: true }).setInputFiles(files);
    await Promise.all([host, guest].map(verified));
    await Promise.all([host, guest].map(installProbe));
    await guest.locator('.mp-ready-bar button').click();
    await host.locator('.mp-ready-bar button').click();
    await host.waitForFunction(() => document.querySelector('.mp-room-heading')?.textContent.includes('2/2 ready'));
    await host.screenshot({ path: resolve(output, 'host-lobby.png') });
    await guest.screenshot({ path: resolve(output, 'guest-lobby.png') });
    await host.getByText('Start Game', { exact: true }).click();
    await advance(150);
    const custom = await Promise.all([host, guest].map(page => page.evaluate(() => {
        const game = window.__ra2debug.game;
        const rules = game.rules.getObject('SMOKETNK', 7), art = game.art.getObject('SMOKETNK', 7);
        return { name: rules.name, strength: rules.strength, cameo: art.cameo, map: game.gameOpts.mapName };
    })));
    assert.deepEqual(custom[0], custom[1]);
    assert.equal(custom[0].strength, 777); assert.equal(custom[0].cameo, 'smokeico'); assert.equal(custom[0].map, customMapName);
    // Test setup creates identical factories at a shared paused frame. Production
    // and movement below use normal guest commands carried over the actual socket.
    await Promise.all([host, guest].map(page => page.evaluate(() => {
        const game = window.__ra2debug.game;
        for (const player of game.playerList.getCombatants()) {
            const mcv = player.getOwnedObjects().find(unit => game.rules.general.baseUnit.includes(unit.name));
            const factory = game.createObject(2, 'GAWEAP'); game.changeObjectOwner(factory, player);
            const tile = game.map.tiles.getByMapCoords(mcv.tile.rx + 5, mcv.tile.ry + 5);
            if (!tile) throw new Error('No factory test location.');
            game.spawnObject(factory, tile);
        }
    })));
    await guest.evaluate(() => {
        const d = window.__ra2debug, rules = d.game.rules.getObject('SMOKETNK', 7);
        if (!d.game.localPlayer.production.isAvailableForProduction(rules)) throw new Error('Custom tank is not buildable.');
        d.actionsApi.queueForProduction(d.game.localPlayer.production.getQueueTypeForObject(rules), 7, 'SMOKETNK', 1);
    });
    await advance(450);
    const built = await guest.evaluate(() => {
        const unit = window.__ra2debug.game.localPlayer.getOwnedObjects().find(unit => unit.name === 'SMOKETNK');
        if (!unit) throw new Error('Custom tank did not leave the production factory.');
        return { id: unit.id, x: unit.tile.rx, y: unit.tile.ry };
    });
    await guest.evaluate(async ({ id }) => {
        const d = window.__ra2debug, game = d.game, unit = game.getObjectById(id);
        const { OrderType } = await import('/src/game/order/OrderType.ts');
        const select = d.actionFactory.create(8); select.player = game.localPlayer; select.unitIds = [id]; d.actionQueue.push(select);
        const move = d.actionFactory.create(9); move.player = game.localPlayer; move.orderType = OrderType.Move;
        move.target = game.createTarget(undefined, game.map.tiles.getByMapCoords(unit.tile.rx + 4, unit.tile.ry)); d.actionQueue.push(move);
    }, built);
    await advance(600);
    const moved = await Promise.all([host, guest].map(page => page.evaluate(id => {
        const unit = window.__ra2debug.game.getObjectById(id);
        return { id: unit.id, x: unit.tile.rx, y: unit.tile.ry };
    }, built.id)));
    assert.deepEqual(moved[0], moved[1]); assert.notDeepEqual(moved[0], built);
    const hashes = await Promise.all([host, guest].map(page => page.evaluate(() => window.__contentSmoke.hashes.filter(frame => frame.tick >= 100))));
    assert.deepEqual(hashes[0], hashes[1]);
    await guest.screenshot({ path: resolve(output, 'guest-game.png') });
    console.log('Custom tank built and moved through network commands; every captured hash matches through tick 600.');
    await guest.evaluate(() => window.__ra2debug.gameScreen.controller.goToScreen(0));
    await guest.getByText('Skirmish', { exact: true }).waitFor({ timeout: 120000 });
    assert.deepEqual(await stockState(guest), clean);
    await guest.getByText('Skirmish', { exact: true }).click();
    await guest.getByText('Start Game', { exact: true }).click();
    await guest.waitForFunction(() => window.__ra2debug?.game && !window.__ra2debug.game.rules.vehicleRules.has('SMOKETNK') && window.__ra2debug.game.currentTick >= 30, undefined, { timeout: 180000 });
    assert.deepEqual(await stockState(guest), clean);
    // Recreate on the same multiplayer screen after leaving a custom-content lobby.
    await host.evaluate(() => window.__ra2debug.gameScreen.controller.goToScreen(0));
    await host.getByText('Multiplayer', { exact: true }).waitFor({ timeout: 120000 });
    await host.getByText('Multiplayer', { exact: true }).click();
    await host.locator('.multiplayer-entry button[type=submit]').first().click();
    await waitLobby(host);
    await host.getByLabel('Host content files', { exact: true }).setInputFiles(files);
    await verified(host);
    await host.getByText('Leave Game', { exact: true }).click();
    await host.waitForSelector('.multiplayer-entry');
    await host.locator('.multiplayer-entry button[type=submit]').first().click();
    await waitLobby(host);
    const recreated = await host.evaluate(() => {
        const session = window.__ra2debug.mainMenuController.getCurrentScreen().client.session;
        return { map: session.gameOpts.mapName, contentFiles: session.content?.files.length || 0 };
    });
    assert.notEqual(recreated.map, customMapName); assert.equal(recreated.contentFiles, 0);
    await host.getByText('Leave Game', { exact: true }).click();
    writeFileSync(resolve(output, 'report.json'), JSON.stringify({ custom: custom[0], built, moved: moved[0], hashes: hashes[0], restored: clean }, null, 2));
    console.log('PASS: content transfer/removal/reload, custom unit production/movement, matching lockstep and clean stock skirmish after leave.');
} catch (error) {
    for (const [name, page] of [['host', host], ['guest', guest]]) {
        if (!page || page.isClosed()) continue;
        diagnostics.push(`${name}: ${await page.locator('body').innerText().catch(() => '')}`);
        await page.screenshot({ path: resolve(output, `${name}-failure.png`) }).catch(() => {});
    }
    writeFileSync(resolve(output, 'failure.log'), diagnostics.join('\n')); throw error;
} finally { await browser?.close(); await app?.close().catch(() => {}); }
