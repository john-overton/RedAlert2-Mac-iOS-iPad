import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

// RA2_PERSISTENT_SMOKE=1 bun scripts/lockstep-engine-smoke.mjs
// Exercises real GameScreen Quit and a second engine launch on the same sockets.
export async function checkPersistentRoom(pages, targetTicks, productionUi = false) {
  const phase = async label => {
    console.log(`[persistent smoke] ${label}`);
    await Promise.all(pages.map(page => page.evaluate(label => { window.__networkSmoke.phase = label; }, label)));
  };
  await phase('Round one synchronized; host returning');
  if (productionUi) await (await import('./network-persistent-ui-smoke.mjs')).checkPersistentGameContent(pages);
  const initial = await Promise.all(pages.map(page => page.evaluate(() => {
    const probe = window.__networkSmoke, client = probe.client;
    probe.firstClient = client;
    probe.firstSocket = client.connection.socket;
    probe.firstMatch = client.getMatchSession();
    probe.closed = [];
    client.connection.onClose.subscribe(reason => probe.closed.push(reason));
    return { hashes: probe.hashes, clientId: client.clientId, generation: probe.firstMatch.start.generation,
      gameId: probe.firstMatch.start.gameId, slots: client.session.clients.map(c => [c.id, c.slotIndex]),
      mapName: client.session.gameOpts.mapName };
  })));
  for (const state of initial) assert.deepEqual(state.hashes, initial[0].hashes, 'Round one hashes');

  const hostDefeat = process.env.RA2_PERSISTENT_HOST_DEFEAT === '1';
  if (hostDefeat) {
    await phase('Defeating host army on every synchronized engine');
    await Promise.all(pages.map(page => page.evaluate(() => {
      const game = window.__ra2debug.game;
      for (const object of [...game.getPlayerByName('Smoke 1').getOwnedObjects(true)].sort((a, b) => a.id - b.id))
        if (!object.isDestroyed) game.destroyObject(object, undefined, true);
    })));
    await Promise.all(pages.map(page => page.evaluate(cap => { window.__networkSmoke.cap = cap; }, targetTicks + 10)));
    await Promise.all(pages.map(page => page.waitForFunction(cap => window.__ra2debug.game.currentTick >= cap,
      targetTicks + 10, { timeout: 30000 })));
    const defeated = await Promise.all(pages.map(page => page.evaluate(() => ({
      defeated: window.__ra2debug.game.getPlayerByName('Smoke 1').defeated, hashes: window.__networkSmoke.hashes,
    }))));
    for (const result of defeated) {
      assert.equal(result.defeated, true, 'Host actually lost its army');
      assert.deepEqual(result.hashes, defeated[0].hashes, 'Defeat fixture stays deterministic');
    }
    // Existing engine behavior lets a defeated commander observe. Exercise their
    // explicit return from that state without changing the game's defeat rules.
  }

  const quit = page => page.evaluate(() => {
    clearInterval(window.__networkSmoke.driver);
    const screen = window.__ra2debug.gameScreen;
    screen.menu.onQuit.dispatch(screen.menu);
  });
  await quit(pages[0]);
  await pages[0].waitForFunction(() => !window.__ra2debug.gameScreen, undefined, { timeout: 30000 });
  if (productionUi) {
    await (await import('./network-persistent-ui-smoke.mjs')).continueToPersistentRoom(pages[0]);
    await pages[0].getByText('Match in progress — waiting for the next round', { exact: true }).waitFor();
    assert.ok(await pages[0].locator('.multiplayer-lobby button').filter({ hasText: /^(Cancel )?Ready$/ }).isDisabled());
  }
  await phase('Host returned; advancing surviving commanders');
  const survivors = pages.slice(1);
  await Promise.all(survivors.map(page => page.evaluate(cap => { window.__networkSmoke.cap = cap; }, targetTicks + 100)));
  await Promise.all(survivors.map(page => page.waitForFunction(cap => window.__ra2debug.game.currentTick >= cap,
    targetTicks + 100, { timeout: 120000 })));
  const continued = await Promise.all(survivors.map(page => page.evaluate(() => ({
    hashes: window.__networkSmoke.hashes, state: window.__networkSmoke.client.session.state,
    actions: window.__ra2debug.gameScreen.replay?.actionRecords.filter(a => a.actionType === 14 || a.actionType === 15),
  }))));
  assert.deepEqual(continued[0].hashes, continued[1].hashes, 'Host forfeit must preserve survivor lockstep');
  for (const state of continued) {
    assert.equal(state.state, 'started', 'Host return must not end the other commanders’ game');
    assert.equal(state.actions?.length, 1, 'Exactly one deterministic host departure');
  }
  await phase('Survivors synchronized; returning everyone to waiting room');
  await Promise.all(survivors.map(quit));
  await Promise.all(pages.map(page => page.waitForFunction(() => !window.__ra2debug.gameScreen
    && window.__networkSmoke.client.session.state === 'waiting', undefined, { timeout: 30000 })));

  if (productionUi) await Promise.all(survivors.map(async page => (await import('./network-persistent-ui-smoke.mjs')).continueToPersistentRoom(page)));

  const returned = await Promise.all(pages.map(page => page.evaluate(() => {
    const probe = window.__networkSmoke, client = probe.client;
    if (client !== probe.firstClient || client.connection.socket !== probe.firstSocket || probe.closed.length)
      throw new Error('Room connection was replaced or closed');
    return { clientId: client.clientId, slots: client.session.clients.map(c => [c.id, c.slotIndex]),
      mapName: client.session.gameOpts.mapName, ready: client.session.clients.map(c => c.ready),
      loaded: client.session.clients.map(c => c.loaded), errors: probe.errors };
  })));
  for (let i = 0; i < pages.length; i++) {
    assert.equal(returned[i].clientId, initial[i].clientId);
    assert.deepEqual(returned[i].slots, initial[i].slots);
    assert.equal(returned[i].mapName, initial[i].mapName);
    assert.ok(returned[i].ready.every(value => !value), 'Readiness reset');
    assert.ok(returned[i].loaded.every(value => value === 0), 'Loading reset');
    assert.deepEqual(returned[i].errors, []);
  }
  await phase('Same room retained; readying round two');
  for (const page of pages) await page.evaluate(({ cap, productionUi }) => {
    const probe = window.__networkSmoke, client = probe.client;
    probe.hashes = []; probe.cap = cap;
    if (productionUi) return;
    client.command('map_ready', { digest: client.session.gameOpts.mapDigest });
    client.command('state', { ready: true, mapDigest: client.session.gameOpts.mapDigest });
  }, { cap: targetTicks, productionUi });
  if (productionUi) await Promise.all(pages.map(page => page.locator('.multiplayer-lobby button').filter({ hasText: /^Ready$/ }).click()));
  await pages[0].waitForFunction(() => window.__networkSmoke.client.session.clients.every(c => c.mapReady && c.ready));
  await phase('Starting round two; waiting for engine load');
  if (productionUi) await pages[0].getByText('Start Game', { exact: true }).click();
  else await pages[0].evaluate(() => window.__networkSmoke.client.command('startgame'));
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__networkSmoke.launches === 2
    && window.__ra2debug.gameScreen?.gameTurnMgr, undefined, { timeout: 180000 })));
  await phase('Round two loaded; advancing engines');
  if (productionUi) await (await import('./network-persistent-ui-smoke.mjs')).checkPersistentGameContent(pages);
  await Promise.all(pages.map(page => page.evaluate(() => {
    const screen = window.__ra2debug.gameScreen;
    screen.gameAnimationLoop.stop();
    window.__networkSmoke.driver = setInterval(() => {
      for (let i = 0; i < 8; i++) if (!screen.gameTurnMgr.doGameTurn(performance.now())) break;
    }, 4);
  })));
  await Promise.all(pages.map(page => page.waitForFunction(cap => window.__ra2debug.game.currentTick >= cap,
    targetTicks, { timeout: 180000 })));
  const second = await Promise.all(pages.map(page => page.evaluate(() => {
    const probe = window.__networkSmoke, match = probe.client.getMatchSession();
    if (match === probe.firstMatch || probe.client !== probe.firstClient
      || probe.client.connection.socket !== probe.firstSocket || probe.closed.length)
      throw new Error('Second round must replace only the match');
    return { generation: match.start.generation, gameId: match.start.gameId, hashes: probe.hashes, errors: probe.errors };
  })));
  for (const state of second) {
    assert.equal(state.generation, initial[0].generation + 1);
    assert.notEqual(state.gameId, initial[0].gameId);
    assert.equal(state.hashes.length, targetTicks);
    assert.deepEqual(state.hashes, second[0].hashes, 'Round two hashes');
    assert.deepEqual(state.errors, []);
  }
  await phase('Round two synchronized; triggering normal victory through army destruction');
  await Promise.all(pages.map(page => page.evaluate(() => {
    const game = window.__ra2debug.game, probe = window.__networkSmoke;
    probe.matchEnds = [];
    probe.client.onMatchEnded.subscribe(message => probe.matchEnds.push(message));
    game.onEnd.subscribe(() => {
      probe.finalResult = { defeated: game.localPlayer.defeated, tick: game.currentTick,
        hostDefeated: game.getPlayerByName('Smoke 1').defeated };
      clearInterval(probe.driver);
    });
    for (const player of game.getAllPlayers().filter(player => !player.isNeutral && player.name !== 'Smoke 1'))
      for (const object of [...player.getOwnedObjects(true)].sort((a, b) => a.id - b.id))
        if (!object.isDestroyed) game.destroyObject(object, undefined, true);
  })));
  await Promise.all(pages.map(page => page.evaluate(cap => { window.__networkSmoke.cap = cap; }, targetTicks + 100)));
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__networkSmoke.finalResult
    && !window.__ra2debug.gameScreen && window.__networkSmoke.client.session.state === 'waiting',
    undefined, { timeout: 30000 })));
  if (productionUi) await Promise.all(pages.map(async page => (await import('./network-persistent-ui-smoke.mjs')).continueToPersistentRoom(page)));
  const finished = await Promise.all(pages.map(page => page.evaluate(() => {
    const probe = window.__networkSmoke, client = probe.client;
    if (client !== probe.firstClient || client.connection.socket !== probe.firstSocket || probe.closed.length)
      throw new Error('Normal victory closed or replaced the room connection');
    return { result: probe.finalResult, endings: probe.matchEnds, errors: probe.errors,
      hashes: probe.hashes, ready: client.session.clients.map(c => c.ready), loaded: client.session.clients.map(c => c.loaded) };
  })));
  for (let i = 0; i < finished.length; i++) {
    const state = finished[i];
    assert.equal(state.result.defeated, i !== 0, 'Host wins; other commanders lose');
    assert.equal(state.result.hostDefeated, false);
    assert.equal(state.endings.length, 1);
    assert.equal(state.endings[0].reason, 'finished', 'Natural completion follows finished protocol');
    assert.deepEqual(state.hashes, finished[0].hashes, 'Final simulation tick hashes');
    assert.ok(state.ready.every(value => !value));
    assert.ok(state.loaded.every(value => value === 0));
    assert.deepEqual(state.errors, []);
  }
  mkdirSync('build', { recursive: true });
  const reportPath = hostDefeat || process.env.RA2_PERSISTENT_CONTENT === '1'
    ? 'build/network-persistent-defeat-content-smoke.json' : 'build/network-persistent-smoke.json';
  writeFileSync(reportPath, JSON.stringify({ hostDefeat, initial, continued, returned, second, finished }, null, 2));
  console.log(`Persistent room: host ${hostDefeat ? 'defeat and return' : 'Quit'}, ${targetTicks + 100} matching survivor ticks, readiness reset, second round with ${targetTicks} matching ticks and natural victory on original sockets passed.`);
}
