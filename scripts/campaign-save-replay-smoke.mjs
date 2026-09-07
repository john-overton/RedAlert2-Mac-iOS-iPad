import {chromium} from '../redalert2/node_modules/playwright-core/index.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 page.setDefaultTimeout(30000);
 const errors=[];
 page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 await page.route('**/config.ini*',route=>route.fulfill({body:readFileSync('redalert2/public/config.ini','utf8').replace('engine = yr','engine = ra2').replace('generalmd.csf','general.csf'),contentType:'text/plain'}));
 await page.route('**/campaign/ra2/allied-01/*',route=>{
  const file=new URL(route.request().url()).pathname.split('/').pop();
  try {return route.fulfill({body:readFileSync(`campaign-export/ra2/allied-01/${file}`),contentType:file.endsWith('json')?'application/json':file.endsWith('mp4')?'video/mp4':'application/octet-stream'});} catch {return route.fulfill({status:404});}
 });
 await page.goto('http://127.0.0.1:4000/?shell=1');
 await page.waitForFunction(()=>window.__ra2debug?.keyBinds,undefined,{timeout:120000});
 console.log('Menu',await page.locator('body').innerText());
 await page.getByText('Campaign',{exact:true}).click();
 await page.getByRole('button',{name:/Red Alert 2 — Allied/}).click();
 await page.getByText('Begin Mission',{exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2,undefined,{timeout:30000});
 await page.getByText('Skip Intro',{exact:true}).click();
 await page.waitForFunction(()=>window.__ra2debug?.game?.campaign,undefined,{timeout:120000});
 console.log('Campaign UI started');
 await page.evaluate(async()=>{
  const d=window.__ra2debug;
  const {Engine}=await import('/src/engine/Engine.ts');
  const {ObjectType}=await import('/src/engine/type/ObjectType.ts');
  const missile=d.game.rules.getObject('DRED',ObjectType.Vehicle).spawns;
  const art=d.game.art.getObject(missile,ObjectType.Aircraft);
  const voxel=Engine.getVoxels().get(`${art.imageName.toLowerCase()}.vxl`);
  if(!voxel?.sections.every(section=>d.gameScreen.vxlGeometryPool.cache.get(section))) {
   throw new Error('Opening missile geometry was not prepared during loading');
  }
 });
 const state=await page.evaluate(()=>{
   const d=window.__ra2debug;const game=d.game;
   d.gameScreen.gameAnimationLoop.stop();
   while(game.currentTick<850)game.update();
   d.gameScreen.renderer.update(performance.now(),0);
   d.gameScreen.renderer.render();
   return {tick:game.currentTick,locked:game.campaign.inputLocked,inputEnabled:d.gameScreen.playerUi.worldInteraction.isEnabled()};
 });
 if(state.locked||!state.inputEnabled)throw new Error('Campaign opening did not return control');
 await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2,undefined,{timeout:30000});
 await page.screenshot({path:'build/campaign-ui.png'});

 const result=await page.evaluate(async()=>{
  const d=window.__ra2debug,g=d.game,screen=d.gameScreen;
  const {ActionType}=await import('/src/game/action/ActionType.ts');
  const {OrderType}=await import('/src/game/order/OrderType.ts');
  const {MapFile}=await import('/src/data/MapFile.ts');
  const {ActionFactory}=await import('/src/game/action/ActionFactory.ts');
  const {ActionFactoryReg}=await import('/src/game/action/ActionFactoryReg.ts');
  const {ReplayTurnManager}=await import('/src/network/gamestate/ReplayTurnManager.ts');
  const {SoloPlayTurnManager}=await import('/src/network/gamestate/SoloPlayTurnManager.ts');
  const tanya=g.localPlayer.getOwnedObjects().find(u=>u.name==='TANY');
  const select=d.actionFactory.create(ActionType.SelectUnits);select.player=g.localPlayer;select.unitIds=[tanya.id];d.actionQueue.push(select);
  const ships=[...g.getPlayerByName('BadGuy2 House').getOwnedObjects()].filter(u=>u.name==='DRED');
  const shipRenderable=d.renderableManager.getRenderableByGameObject(ships[0]);
  for(const ship of ships){
   const order=d.actionFactory.create(ActionType.OrderUnits);order.player=g.localPlayer;order.orderType=OrderType.Attack;order.target=g.createTarget(ship,ship.tile);d.actionQueue.push(order);
   for(let i=0;i<2400&&!ship.isDestroyed;i++)screen.gameTurnMgr.doGameTurn(performance.now());
   if(!ship.isDestroyed)throw new Error('Recorded attack failed to sink ship');
  }
  const start=performance.now();
  for(let i=0;i<=4200;i+=100)d.renderer.update(start+i,0);
  if(shipRenderable.mainObj.visible)throw new Error('Dreadnought remained visible after sinking');
  const move=d.actionFactory.create(ActionType.OrderUnits);move.player=g.localPlayer;move.orderType=OrderType.Move;move.target=g.createTarget(undefined,g.map.getTileAtWaypoint(16));d.actionQueue.push(move);
  for(let i=0;i<2500;i++)screen.gameTurnMgr.doGameTurn(performance.now());
  const {ObjectType}=await import('/src/engine/type/ObjectType.ts');
  const barracks=g.rules.getObject('GAPILE',ObjectType.Building);
  d.actionsApi.queueForProduction(g.localPlayer.production.getQueueTypeForObject(barracks),ObjectType.Building,'GAPILE',1);
  for(let i=0;i<15;i++)screen.gameTurnMgr.doGameTurn(performance.now());
  if(!g.localPlayer.production.getQueueForObject(barracks).find(barracks).length)throw new Error('Production queue was not started');
  await screen.saveGame(g);
  const manager=screen.replayManager;
  const meta=(await manager.loadList()).find(m=>m.name.startsWith('[SAVE]'));
  const save=await manager.loadReplay(meta);
  const snapshot=game=>({tick:game.currentTick,hash:game.getHash(),credits:game.localPlayer.credits,production:game.localPlayer.production.getQueueForObject(game.rules.getObject('GAPILE',ObjectType.Building)).find(game.rules.getObject('GAPILE',ObjectType.Building)).map(q=>({progress:q.progress,creditsSpent:q.creditsSpent,quantity:q.quantity})),owned:game.localPlayer.getOwnedObjects().map(u=>u.id),selected:[...game.campaign.selectedUnitIds],fired:[...game.campaign.firedTriggers],locals:[...game.triggers.localVariables].map(([k,v])=>[k,v.value]),teams:game.campaign.teams.active.map(t=>({id:t.id,line:t.line,started:t.started,until:t.until,members:t.members.map(u=>u.id)}))});
  const expected=snapshot(g);
  const mapText=await(await fetch('/campaign/ra2/allied-01/all01t.map')).text();
  const checks=[];
  for(const mode of ['resume','replay']){
   const {game}=await screen.gameLoader.createGame(save.gameId,save.gameTimestamp*1000,save.gameOpts,new MapFile(mapText),true,{});
   const human=game.getPlayerByName('Player House');game.init(human);
   const factory=new ActionFactory();new ActionFactoryReg().register(factory,game,human.name);
   const turn=mode==='resume'?new SoloPlayTurnManager(game,human,{dequeueAll:()=>[]},undefined,undefined,{records:save.actionRecords,untilTick:save.finishedTick,actionFactory:factory}):new ReplayTurnManager(game,save,factory);
   turn.init();game.start();
   while(game.currentTick<save.finishedTick)turn.doGameTurn(performance.now());
   const actual=snapshot(game);
   checks.push({mode,matches:JSON.stringify(actual)===JSON.stringify(expected),actual});
   turn.dispose();game.dispose();
  }
  return {sinking:true,records:save.actionRecords.length,expected,checks};
 });
 writeFileSync('build/campaign-save-replay-result.json',JSON.stringify(result,null,2));
 if(result.checks.some(c=>!c.matches))throw new Error('Campaign save/replay diverged; see result JSON');
 if(errors.length)throw new Error('Campaign save/replay reported browser errors');

 await page.evaluate(async()=>{
  const d=window.__ra2debug;
  window.__rootController=d.gameScreen.controller;
  window.__playLabel=d.gameScreen.strings.get('GUI:LoadReplay');
  window.__originalGame=d.game;
  window.__savedHash=d.game.getHash();
  window.__savedTick=d.game.currentTick;
  const {GameAnimationLoop}=await import('/src/engine/GameAnimationLoop.ts');
  GameAnimationLoop.prototype.start=function(){}; // Inspect the exact restored tick before live input resumes.
  d.gameScreen.menu.open();
 });
 console.log('Saving from menu');
 await page.getByText('Save Game',{exact:true}).click();
 await page.waitForFunction(async()=> (await window.__ra2debug.gameScreen.replayManager.loadList()).filter(m=>m.name.startsWith('[SAVE]')).length>=2);
 console.log('Saved from menu');
 await page.evaluate(()=>{window.__savedHash=window.__ra2debug.game.getHash();window.__savedTick=window.__ra2debug.game.currentTick;});
 await page.evaluate(()=>window.__rootController.goToScreen(0));
 await page.getByText('Load Game',{exact:true}).click();
 await page.getByText('Load Game',{exact:true}).last().click();
 console.log('Loading from menu');
 await page.waitForFunction(()=>window.__ra2debug.game!==window.__originalGame&&window.__ra2debug.game?.currentTick===window.__savedTick,undefined,{timeout:120000});
 await page.evaluate(()=>{
  const d=window.__ra2debug;
  if(d.game.getHash()!==window.__savedHash)throw new Error('Load Game menu restored a different state');
  if(d.game.campaign.presentation.length)throw new Error('Load Game retained historical cutscenes');
 });
 await page.evaluate(()=>window.__rootController.goToScreen(0));
 await page.getByText('Replays',{exact:true}).click();
 console.log('Replay menu',await page.locator('body').innerText());
 const playLabel=await page.evaluate(()=>window.__playLabel);
 console.log('Replay button',playLabel);
 await page.getByText(playLabel,{exact:true}).click();
 await page.waitForFunction(()=>window.__rootController.getCurrentScreen()?.constructor.name==='ReplayScreen'&&window.__rootController.getCurrentScreen().gameTurnMgr,undefined,{timeout:120000});
 const replayUi=await page.evaluate(()=>{
  const screen=window.__rootController.getCurrentScreen();
  while(screen.game.currentTick<screen.params.replay.finishedTick)screen.gameTurnMgr.doGameTurn(performance.now());
  screen.renderer.update(performance.now(),0);screen.renderer.render();
  if(screen.game.getHash()!==window.__savedHash)throw new Error('Replay menu playback diverged');
  return {tick:screen.game.currentTick,finished:screen.gameTurnMgr.isFinished()};
 });
 result.menuSaveLoad=true;result.replayUi=replayUi;
 writeFileSync('build/campaign-save-replay-result.json',JSON.stringify(result,null,2));
 if(errors.length)throw new Error('Save/load/replay menus reported browser errors');
 console.log('Campaign sinking, save and replay state checks passed',result.expected.tick,result.records);
} finally {await browser.close();}
