// Used by lockstep-engine-smoke with RA2_GAME_UI_SMOKE=1.
export async function checkGameHud(pages) {
  const page = pages[0];
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug.gameScreen.chatTypingHandler && window.__networkSmoke.client.getMatchSession().areAllPlayersLoaded())));
  const input = page.locator('.game-chat-input input');
  await page.keyboard.press('Enter');
  await input.waitFor({ state: 'visible' });
  const bounds = await page.locator('.game-chat-console').boundingBox();
  if (!bounds || bounds.y < 400 || bounds.y + bounds.height > 900) throw new Error(`Composer is not at the bottom: ${JSON.stringify(bounds)}`);
  await input.fill('HUD broadcast smoke');
  await page.keyboard.press('Enter');
  await input.waitFor({ state: 'hidden' });
  for (const receiver of pages) await receiver.waitForFunction(() => window.__ra2debug.gameScreen.hud.messageList.getAll().some(message => message.text.includes('HUD broadcast smoke')));
  await page.keyboard.press('Enter');
  await input.waitFor({ state: 'visible' });
  await page.keyboard.press('Tab');
  const teamLabel = await page.locator('.game-chat-input label').innerText();
  await input.fill('HUD private team smoke');
  await page.keyboard.press('Enter');
  await input.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.__ra2debug.gameScreen.hud.messageList.getAll().some(message => message.text.includes('HUD private team smoke')));
  // Opponents have no assigned team in this fixture; server echoes only to sender.
  if (await pages[1].evaluate(() => window.__ra2debug.gameScreen.hud.chatHistory.getAll().some(message => message.text.includes('HUD private team smoke')))) throw new Error('Team chat leaked to an opponent');
  await page.keyboard.press('Enter');
  await input.waitFor({ state: 'visible' });
  if (await page.locator('.game-chat-input label').innerText() !== teamLabel) throw new Error('Chat audience was not remembered');
  // History survives expiring HUD notifications and updates while composing.
  await page.evaluate(() => {
    const list = window.__ra2debug.gameScreen.hud.messageList;
    for (let i = 0; i < 12; i++) list.addChatMessage(`History smoke ${i}`, '#55ff55');
    for (const message of list.getAll()) message.time -= 120000;
    list.prune();
  });
  const history = page.locator('.game-chat-history');
  await page.waitForFunction(() => document.querySelector('.game-chat-history')?.children.length === 10);
  if (await history.locator('div').first().innerText() !== 'History smoke 2' || await history.locator('div').last().innerText() !== 'History smoke 11') throw new Error('Wrong retained chat history');
  await page.keyboard.press('Escape');
  await input.waitFor({state:'hidden'});
  await page.keyboard.press('Enter');
  await input.waitFor({state:'visible'});
  if (await history.locator('div').count() !== 10) throw new Error('Chat history lost on reopen');
  const expanded = await page.locator('.game-chat-console').boundingBox();
  if (!expanded || expanded.y < 0 || expanded.y + expanded.height > 900 || expanded.height < 200) throw new Error(`History panel clipped: ${JSON.stringify(expanded)}`);
  await page.locator('.game-chat-console').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await page.screenshot({path:'build/macos/chat-popout.png'});
  await input.fill('Cancelled message');
  await page.keyboard.press('Escape');
  await input.waitFor({ state: 'hidden' });
  if (await page.evaluate(() => window.__ra2debug.gameScreen.playerUi.worldInteraction.keyboardHandler.isPaused)) throw new Error('Keyboard stayed paused after cancel');
  await page.evaluate(async () => {
    const {SuperWeaponType} = await import('/src/game/type/SuperWeaponType.ts');
    const {PointerType} = await import('/src/engine/type/PointerType.ts');
    const {SpecialActionMode} = await import('/src/gui/screen/game/worldInteraction/SpecialActionMode.ts');
    const screen = window.__ra2debug.gameScreen;
    const pointer = screen.pointer;
    const mode = new SpecialActionMode(new Map(), {type:SuperWeaponType.SpyPlane}, {}, pointer, {});
    mode.hover({tile:{}});
    if (pointer.getSprite().getFrame() !== 504) throw new Error('Spy plane did not select its YR cursor');
    const runner = pointer.getSprite().getAnimationRunner();
    if (runner.animation.props.loopEnd !== 511) throw new Error('Spy plane animation spills into other cursors');
    pointer.setPointerType(PointerType.Beacon);
    if (pointer.getSprite().getAnimationRunner().animation.props.loopEnd !== 449) throw new Error('Beacon animation spills into YR cursors');
    const sprite = pointer.getSprite();
    const getFrameCount = sprite.getFrameCount;
    try {
      sprite.getFrameCount = () => 450;
      pointer.setPointerType(PointerType.SpyPlane);
      if (sprite.getFrame() !== 214) throw new Error('Classic cursor fallback is missing');
    } finally { sprite.getFrameCount = getFrameCount; pointer.setPointerType(PointerType.Default); }
    const timer = screen.hud.superWeaponTimers;
    const original = timer.props;
    let remaining = 125;
    const spy = { rules: { type:SuperWeaponType.SpyPlane, showTimer:false, uiName:'SPY_TIMER_TEST' }, getTimerSeconds:()=>remaining };
    const local = {defeated:false,color:{asHexString:()=>'lime'},superWeaponsTrait:{getAll:()=>[spy]}};
    const enemy = {...local,color:{asHexString:()=>'red'}};
    try {
      timer.props = {...original,players:[local,enemy],localPlayer:local,countdownTimer:{isRunning:()=>false},stalemateDetectTrait:undefined,strings:{get:key=>key}};
      timer.lastUpdate=undefined;
      timer.onFrame(performance.now());
      const signature = timer.lastSignature;
      if (!signature.includes('SPY_TIMER_TEST') || !signature.includes('02:05') || signature.includes('red') || signature.split('\n').length !== 1) throw new Error(`Wrong spy timer visibility: ${signature}`);
      remaining = 0;
      timer.onFrame(performance.now() + 200);
      if (!timer.lastSignature.includes('00:00')) throw new Error('Spy timer does not reach ready');
    } finally { timer.props=original; timer.lastUpdate=undefined; }
  });
  console.log('HUD chat send/cancel/audience, spy-plane cursor and local countdown passed');
}
