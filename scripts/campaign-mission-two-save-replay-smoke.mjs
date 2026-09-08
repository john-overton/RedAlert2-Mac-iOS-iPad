import { campaignTestConfig } from './campaign-test-config.mjs';
import {chromium} from '../redalert2/node_modules/playwright-core/index.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 page.setDefaultTimeout(30000);
 const errors=[];
 page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 await page.route('**/config.ini*',route=>route.fulfill({body:campaignTestConfig(),contentType:'text/plain'}));
 await page.route('**/campaign/ra2/allied-02/*',route=>{
  const file=new URL(route.request().url()).pathname.split('/').pop();
  try {return route.fulfill({body:readFileSync(`campaign-export/ra2/allied-02/${file}`),contentType:file.endsWith('json')?'application/json':file.endsWith('mp4')?'video/mp4':'application/octet-stream'});} catch {return route.fulfill({status:404});}
 });
 await page.goto('http://127.0.0.1:4000/?shell=1');
 await page.waitForFunction(()=>window.__ra2debug?.keyBinds,undefined,{timeout:120000});
 console.log('Menu',await page.locator('body').innerText());
 await page.evaluate(()=>localStorage.setItem('ra2.alliedCampaign.progress.v1',JSON.stringify({started:true,completed:[]})));
 await page.getByText('Campaign',{exact:true}).click();
 await page.getByRole('button',{name:/Red Alert 2 — Allied/}).click();
 await page.getByRole('button',{name:'Mission Two: Eagle Dawn',exact:true}).click();
 await page.getByText('Begin Mission',{exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2,undefined,{timeout:30000});
 await page.getByText('Skip Intro',{exact:true}).click();
 await page.waitForFunction(()=>window.__ra2debug?.game?.campaign,undefined,{timeout:120000});
 console.log('Campaign UI started');
 await page.evaluate(()=>window.__ra2debug.gameScreen.gameAnimationLoop.stop());
 const result=await page.evaluate(async()=>{
  const d=window.__ra2debug,g=d.game,screen=d.gameScreen;
  const {ActionType}=await import('/src/game/action/ActionType.ts');
  const {OrderType}=await import('/src/game/order/OrderType.ts');
  const {MapFile}=await import('/src/data/MapFile.ts');
  const {ActionFactory}=await import('/src/game/action/ActionFactory.ts');
  const {ActionFactoryReg}=await import('/src/game/action/ActionFactoryReg.ts');
  const {ReplayTurnManager}=await import('/src/network/gamestate/ReplayTurnManager.ts');
  const {SoloPlayTurnManager}=await import('/src/network/gamestate/SoloPlayTurnManager.ts');
  const tanya=g.getPlayerByName('Germans').getOwnedObjects().find(u=>u.name==='TANY');
  const select=d.actionFactory.create(ActionType.SelectUnits);select.player=g.localPlayer;select.unitIds=[tanya.id];d.actionQueue.push(select);
  const order=d.actionFactory.create(ActionType.OrderUnits);order.player=g.localPlayer;order.orderType=OrderType.Move;
  order.target=g.createTarget(undefined,g.map.tiles.getByMapCoords(tanya.tile.rx-3,tanya.tile.ry));d.actionQueue.push(order);
  while(g.currentTick<1800)screen.gameTurnMgr.doGameTurn(performance.now());
  if(tanya.tile.rx===121&&tanya.tile.ry===117)throw new Error('Recorded cross-house move failed');
  await screen.saveGame(g);
  const meta=(await screen.replayManager.loadList()).find(m=>m.name.startsWith('[SAVE]'));
  const save=await screen.replayManager.loadReplay(meta);
  const snapshot=game=>({tick:game.currentTick,hash:game.getHash(),
    selected:[...game.campaign.selectedUnitIds],fired:[...game.campaign.firedTriggers],pending:game.campaign.teams.pending,
    locals:[...game.triggers.localVariables].map(([k,v])=>[k,v.value]),
    houses:game.getAllPlayers().map(p=>({name:p.name,credits:p.credits,objects:p.getOwnedObjects(true).map(u=>({id:u.id,name:u.name,hp:u.healthTrait.health,x:u.tile.rx,y:u.tile.ry})),queues:p.production?.getAllQueues().map(q=>q.getAll().map(i=>({name:i.rules.name,progress:i.progress,quantity:i.quantity})))})),
    teams:game.campaign.teams.active.map(t=>({id:t.id,line:t.line,started:t.started,until:t.until,members:t.members.map(u=>u.id)}))});
  const expected=snapshot(g);
  const mapText=await(await fetch('/campaign/ra2/allied-02/all02s.map')).text();
  const checks=[];
  for(const mode of ['resume','replay']){
   const {game}=await screen.gameLoader.createGame(save.gameId,save.gameTimestamp*1000,save.gameOpts,new MapFile(mapText),true,{});
   const human=game.getPlayerByName('Americans');game.init(human);
   const factory=new ActionFactory();new ActionFactoryReg().register(factory,game,human.name);
   const turn=mode==='resume'?new SoloPlayTurnManager(game,human,{dequeueAll:()=>[]},undefined,undefined,{records:save.actionRecords,untilTick:save.finishedTick,actionFactory:factory}):new ReplayTurnManager(game,save,factory);
   turn.init();game.start();
   while(game.currentTick<save.finishedTick)turn.doGameTurn(performance.now());
   const actual=snapshot(game);
   checks.push({mode,matches:JSON.stringify(actual)===JSON.stringify(expected),actual});
   turn.dispose();game.dispose();
  }
  return {crossHouseOrders:true,records:save.actionRecords.length,expected,checks};
 });
 writeFileSync('build/campaign-mission-two-save-replay-result.json',JSON.stringify(result,null,2));
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
  if(!d.game.unitSelection.getSelectedUnits().some(u=>u.name==='TANY'&&u.owner.name==='Germans'))throw new Error('Load Game lost the cross-house selection');
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
 const progress=await page.evaluate(()=>JSON.parse(localStorage.getItem('ra2.alliedCampaign.progress.v1')));
 if(progress.completed.length)throw new Error('Save/load/replay awarded an unearned victory');
 // Upgrade path: old saves identify a started campaign without inventing wins.
 await page.evaluate(()=>{localStorage.removeItem('ra2.alliedCampaign.progress.v1');window.__rootController.goToScreen(0);});
 await page.getByText('Campaign',{exact:true}).click();
 await page.getByRole('button',{name:/Red Alert 2 — Allied/}).click();
 await page.getByRole('region',{name:'Allied campaign'}).getByText('0% complete',{exact:false}).waitFor();
 await page.getByText('Back',{exact:true}).click();
 result.menuSaveLoad=true;result.replayUi=replayUi;result.legacyProgressRecognized=true;
 writeFileSync('build/campaign-mission-two-save-replay-result.json',JSON.stringify(result,null,2));
 if(errors.length)throw new Error('Save/load/replay menus reported browser errors');
 console.log('Mission two save and replay state checks passed',result.expected.tick,result.records);
} finally {await browser.close();}
