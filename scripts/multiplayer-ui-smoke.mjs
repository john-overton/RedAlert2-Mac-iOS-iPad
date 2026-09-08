// node scripts/multiplayer-ui-smoke.mjs
// Requires built Linux YR app and RA2_HTTP=1 Vite at port 4000. Uses actual Electron
// host bridge plus a Chromium guest; keeps test profiles under build/.
import { _electron as electron, chromium } from '../redalert2/node_modules/playwright-core/index.mjs';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '..');
const app = await electron.launch({ executablePath: process.env.RA2_ELECTRON || '/usr/lib/electron43/electron',
    args: [resolve(root, 'build/linux/yr/app'), '--ozone-platform=wayland', `--user-data-dir=${resolve(root, 'build/multiplayer-ui-host-profile')}`], timeout: 60000 });
let browser, host, guest;
const output = resolve(root, 'build/multiplayer-ui');
mkdirSync(output, { recursive: true });
const diagnostics = [];
function observe(page, name) {
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => diagnostics.push(`${name}: ${error.stack}`));
    page.on('console', message => {
        if (message.type() === 'error') diagnostics.push(`${name}: ${message.text()}`);
    });
    page.on('websocket', socket => {
        diagnostics.push(`${name}: websocket opened`);
        socket.on('framereceived', ({ payload }) => {
            if (typeof payload === 'string') {
                const message = JSON.parse(payload);
                if (message.type === 'error') diagnostics.push(`${name}: ${payload}`);
            }
        });
    });
}
async function choose(page, selector, label) {
    await page.locator(`${selector} .select-value`).click();
    if (selector.includes('player-team-select')) assert.equal(await page.locator(`${selector} .select-layer`).getByText('Observer', { exact: true }).count(), 0);
    await page.locator(`${selector} .select-layer`).getByText(label, { exact: true }).click();
}
try {
    host = await app.firstWindow();
    observe(host, 'host');
    await host.getByText('Multiplayer', { exact: true }).waitFor({ timeout: 300000 });
    await host.getByText('Multiplayer', { exact: true }).click();
    await host.getByLabel('Player name', { exact: true }).fill('Host UI');
    await host.getByLabel('Port', { exact: true }).fill('19620');
    await host.getByLabel('Password', { exact: true }).first().fill('smoke');
    await host.locator('.multiplayer-entry button[type=submit]').first().click();
    await host.waitForSelector('.multiplayer-lobby', { timeout: 180000 });
    console.log('Electron host lobby ready.');
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true });
    guest = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    observe(guest, 'guest');
    await guest.goto('http://127.0.0.1:4000/?shell=1');
    await guest.getByText('Multiplayer', { exact: true }).waitFor({ timeout: 300000 });
    await guest.getByText('Multiplayer', { exact: true }).click();
    console.log('Chromium guest menu ready.');
    await guest.getByLabel('Player name', { exact: true }).fill('Guest UI');
    await guest.getByLabel('Address', { exact: true }).fill('127.0.0.1:19620');
    await guest.getByLabel('Password', { exact: true }).last().fill('wrong');
    await guest.locator('.multiplayer-entry button[type=submit]').last().click();
    await guest.getByRole('alert').waitFor({ timeout: 180000 });
    assert.match(await guest.getByRole('alert').innerText(), /password is incorrect/);
    console.log('Wrong password rejected; retrying.');
    await guest.getByLabel('Password', { exact: true }).last().fill('smoke');
    await guest.locator('.multiplayer-entry button[type=submit]').last().click();
    await guest.waitForSelector('.multiplayer-lobby', { timeout: 180000 });
    await host.getByText('Guest UI', { exact: true }).first().waitFor();
    // Leaving the embedded host closes the guest and allows the same port to be reused.
    await host.getByText('Leave Game', { exact: true }).click();
    await host.waitForSelector('.multiplayer-entry');
    await guest.waitForSelector('.multiplayer-entry');
    await host.locator('.multiplayer-entry button[type=submit]').first().click();
    await host.waitForSelector('.multiplayer-lobby', { timeout: 30000 });
    await guest.locator('.multiplayer-entry button[type=submit]').last().click();
    await guest.waitForSelector('.multiplayer-lobby', { timeout: 30000 });
    console.log('Host departure and port reuse verified.');
    // Configure through the same original RA2 controls that players use.
    await host.getByText('Change Map', { exact: true }).click();
    await host.locator('.map-list').getByText('The Alamo (2)', { exact: true }).dblclick();
    await host.waitForSelector('.multiplayer-lobby');
    await host.getByText('Change Map', { exact: true }).click();
    await host.locator('.map-list').getByText('Stormy Weather (2-4)', { exact: true }).dblclick();
    await host.waitForSelector('.multiplayer-lobby');
    await guest.getByText('Stormy Weather (2-4)', { exact: false }).waitFor();
    // Selecting the same map again must retain its validated local file.
    await host.getByText('Change Map', { exact: true }).click();
    await host.getByText('Use Map', { exact: true }).click();
    await host.waitForSelector('.multiplayer-lobby');
    assert.equal(await host.getByRole('alert').count(), 0);
    await choose(host, '.player-slot:nth-child(4) .player-name', 'AI - Easy');
    await guest.locator('.player-slot:nth-child(4) .player-name').getByText('AI - Easy', { exact: true }).waitFor();
    const crates = host.locator('input[name=cratesAppear]');
    const nextCrates = !(await crates.isChecked());
    await crates.click();
    await host.waitForFunction(value => document.querySelector('input[name=cratesAppear]')?.checked === value, nextCrates);
    await guest.waitForFunction(value => document.querySelector('input[name=cratesAppear]')?.checked === value, nextCrates);
    await choose(host, '.player-slot:nth-child(2) .player-team-select', 'A');
    await choose(guest, '.player-slot:nth-child(3) .player-team-select', 'A');
    await host.locator('.new-message input').fill('All commanders report in.');
    await host.locator('.new-message input').press('Enter');
    await guest.locator('.messages').getByText('All commanders report in.', { exact: false }).waitFor();
    await guest.locator('.new-message input').press('Tab');
    await guest.locator('.new-message input').fill('Allied channel confirmed.');
    await guest.locator('.new-message input').press('Enter');
    await host.locator('.messages').getByText('Allied channel confirmed.', { exact: false }).waitFor();
    console.log('Map change, bot, options, teams and lobby chat verified.');
    await guest.locator('.mp-ready-bar button').click();
    await guest.getByText('Ready for battle', { exact: true }).waitFor();
    await host.locator('.mp-ready-bar button').click();
    await host.getByText('Ready for battle', { exact: true }).waitFor();
    // Readiness has propagated to both lobby views and the host's Start button.
    await host.waitForFunction(() => document.querySelector('.mp-room-heading')?.textContent.includes('2/2 ready'));
    await guest.waitForFunction(() => document.querySelector('.mp-room-heading')?.textContent.includes('2/2 ready'));
    mkdirSync(resolve(root, 'build/multiplayer-ui'), { recursive: true });
    await host.screenshot({ path: resolve(root, 'build/multiplayer-ui/host-lobby.png') });
    await guest.screenshot({ path: resolve(root, 'build/multiplayer-ui/guest-lobby.png') });
    assert.equal(await host.evaluate(() => window.__RA2_SHELL__.platform), 'linux');
    await host.getByText('Start Game', { exact: true }).click();
    await Promise.all([host, guest].map(page => page.waitForFunction(
        () => window.__ra2debug?.game?.currentTick >= 30, undefined, { timeout: 180000 })));
    await host.screenshot({ path: resolve(output, 'host-game.png') });
    await guest.screenshot({ path: resolve(output, 'guest-game.png') });
    console.log('Both clients started and advanced at least 30 simulation ticks.');
    // Closing the physical host terminates its server and releases the port.
    await app.close();
    const net = await import('node:net');
    const probe = net.createServer();
    await new Promise((resolve, reject) => probe.once('error', reject).listen(19620, '0.0.0.0', resolve));
    await new Promise(resolve => probe.close(resolve));
    console.log('PASS: Electron host, password retry, map/bot/options/team/chat UI, ready/start, running game and port release.');

} catch (error) {
    for (const [name, page] of [['host', host], ['guest', guest]]) {
        if (!page || page.isClosed()) continue;
        diagnostics.push(`${name}: ${await page.locator('body').innerText().catch(() => '')}`);
        await page.screenshot({ path: resolve(output, `${name}-failure.png`) }).catch(() => {});
    }
    writeFileSync(resolve(output, 'failure.log'), diagnostics.join('\n'));
    throw error;
} finally { await browser?.close(); await app.close().catch(() => {}); }
