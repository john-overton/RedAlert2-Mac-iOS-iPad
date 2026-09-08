// Requires an asset-seeded Vite server. Exercises actual sidebar Back buttons.
import assert from 'node:assert/strict';
import { chromium } from '../redalert2/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.RA2_DEV_URL || 'http://127.0.0.1:4002'}/?shell=1`);
  await page.waitForFunction(() => window.__ra2debug?.keyBinds, undefined, {timeout:300000});
  for (const direct of [false, true, false, true]) {
    console.log(`Entering ${direct ? 'direct route' : 'normal menu'}`);
    if (direct) {
      // Match returns construct a fresh menu controller routed directly to
      // Multiplayer, leaving no Home screen underneath it in the stack.
      await page.evaluate(async () => {
        const {MainMenuScreenType} = await import('/src/gui/screen/ScreenType.ts');
        await Promise.race([
          window.__ra2debug.mainMenuController.goToScreenBlocking(MainMenuScreenType.Multiplayer),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Direct route transition stalled')), 10000)),
        ]);
      });
    } else await page.getByText('Multiplayer', {exact:true}).click();
    await page.getByText('Back', {exact:true}).waitFor({state:'visible'});
    await page.getByText('Back', {exact:true}).click();
    await page.getByText('Skirmish', {exact:true}).waitFor({state:'visible',timeout:10000});
    assert.equal(await page.evaluate(() => window.__ra2debug.mainMenuController.getCurrentScreenType()), 0);
    console.log(`Back restored Home (${direct ? 'direct match-return route' : 'normal menu entry'})`);
    await page.waitForTimeout(500);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
