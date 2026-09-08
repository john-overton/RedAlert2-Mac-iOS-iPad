// The native hosting bridge is replaced; MultiplayerScreen and its owner,
// LobbyClient, score navigation and engine launches remain production code.
export async function connectPersistentUi(page, index, gameOpts, port) {
  await page.evaluate(async ({ index, gameOpts, port }) => {
    const probe = window.__networkSmoke;
    probe.hostCalls = 0; probe.stopCalls = 0;
    window.__RA2_SHELL__ = { ...window.__RA2_SHELL__,
      hostGame: async options => { probe.hostCalls++; return window.__persistentHostGame(options); },
      stopHosting: async () => { probe.stopCalls++; return window.__persistentStopHosting(); },
    };
    const { MainMenuScreenType } = await import('/src/gui/screen/ScreenType.ts');
    const controller = window.__ra2debug.mainMenuController;
    await controller.goToScreenBlocking(MainMenuScreenType.Multiplayer, {});
    const screen = probe.roomScreen = controller.getCurrentScreen();
    screen.fields = { ...screen.fields, playerName: `Smoke ${index + 1}`, address: `127.0.0.1:${port}`, port: '1620' };
    if (!index) screen.pregame.hydrate({ gameOpts,
      slotsInfo: Array.from({ length: gameOpts.maxSlots }, (_, i) => ({ type: i === 0 ? 1 : 0 })) });
    await screen.connect(index === 0);
    if (!screen.client?.session) throw new Error(screen.error || 'Production multiplayer connect failed');
    const client = probe.client = screen.client;
    client.onError.subscribe(error => probe.errors.push({ code: error.code, message: error.message }));
    client.onStartGame.subscribe(() => { probe.launches++; probe.match = client.getMatchSession(); });
  }, { index, gameOpts, port });
  await page.waitForFunction(() => {
    const probe = window.__networkSmoke;
    return probe.client.session.clients.find(c => c.id === probe.client.clientId)?.mapReady;
  }, undefined, { timeout: 120000 });
}

export async function continueToPersistentRoom(page) {
  await page.evaluate(async () => {
    const probe = window.__networkSmoke;
    if (probe.contentFixture) {
      const { Engine } = await import('/src/engine/Engine.ts');
      if (Engine.rules !== probe.baseRules || Engine.rules.getSection('MTNK').getNumber('Strength') !== probe.baseStrength)
        throw new Error('Score screen retained session rules instead of restoring base rules');
    }
  });
  await page.getByText('Continue', { exact: true }).click();
  await page.locator('.multiplayer-lobby').waitFor({ state: 'visible', timeout: 30000 });
  await page.evaluate(() => {
    const probe = window.__networkSmoke, screen = probe.roomScreen;
    const original = screen.onViewportChange;
    probe.resized = false;
    screen.onViewportChange = function (...args) { probe.resized = true; return original.apply(this, args); };
  });
  const width = page.viewportSize().width === 1360 ? 1280 : 1360;
  await page.setViewportSize({ width, height: 920 });
  await page.waitForFunction(width => window.innerWidth === width && window.__networkSmoke.resized, width);
  await page.evaluate(() => {
    const probe = window.__networkSmoke;
    const screen = window.__ra2debug.mainMenuController.getCurrentScreen();
    if (screen !== probe.roomScreen || screen.client !== probe.client)
      throw new Error('Score Continue replaced the production room owner or client');
    if (screen.launching || probe.stopCalls) throw new Error('Room still launching or hosting was stopped');
    if (probe.client.session.clients.find(c => c.id === probe.client.clientId)?.admin
      && (!screen.hosting || probe.hostCalls !== 1)) throw new Error('Hosted process ownership was lost or recreated');
  });
  await page.waitForFunction(() => {
    const probe = window.__networkSmoke;
    return !probe.contentFixture || probe.client.session.state !== 'waiting'
      || (!probe.roomScreen.contentBusy && probe.roomScreen.mountedContent === probe.client.session.content.id);
  });
}

export async function preparePersistentContent(pages) {
  await Promise.all(pages.map(page => page.evaluate(async () => {
    const { Engine } = await import('/src/engine/Engine.ts');
    const probe = window.__networkSmoke;
    probe.contentFixture = true; probe.baseRules = Engine.rules;
    probe.baseStrength = Engine.rules.getSection('MTNK').getNumber('Strength');
    if (probe.baseStrength === 801) throw new Error('Content fixture must differ from base rules');
  })));
  await pages[0].evaluate(async () => {
    await window.__networkSmoke.roomScreen.importContent([new File(['[MTNK]\nStrength=801\n'], 'rules.ini')]);
  });
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    const probe = window.__networkSmoke, session = probe.client.session;
    return session.content?.files.length === 1 && !probe.roomScreen.contentBusy
      && probe.roomScreen.mountedContent === session.content.id
      && session.clients.every(c => c.contentReady === session.content.id);
  }, undefined, { timeout: 120000 })));
  console.log('[persistent smoke] Production content upload verified on every client');
}

export async function checkPersistentGameContent(pages) {
  await Promise.all(pages.map(page => page.evaluate(async () => {
    if (!window.__networkSmoke.contentFixture) return;
    const { Engine } = await import('/src/engine/Engine.ts');
    const { ObjectType } = await import('/src/engine/type/ObjectType.ts');
    if (Engine.rules.getSection('MTNK').getNumber('Strength') !== 801
      || window.__ra2debug.game.rules.getObject('MTNK', ObjectType.Vehicle).strength !== 801)
      throw new Error('Session unit patch was not applied to this game');
  })));
}
