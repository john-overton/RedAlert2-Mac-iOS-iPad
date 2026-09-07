import {chromium} from '../redalert2/node_modules/playwright-core/index.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
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
 const campaignList = page.getByRole('region',{name:'Campaign selection'});
 await campaignList.waitFor();
 if(await campaignList.locator('button:disabled').count()!==3)throw new Error('Expected three placeholder campaigns');
 await page.screenshot({path:'build/campaign-list.png'});
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
 for (const width of [1024,1280]) {
  await page.setViewportSize({width,height:900});
  await page.evaluate(()=>{
   const d=window.__ra2debug;
   d.renderer.update(performance.now(),0);
   const canvas=d.renderer.getCanvas(),rect=canvas.getBoundingClientRect();
   const viewport=d.worldScene.viewport;
   const edge=rect.left+(viewport.x+viewport.width)*rect.width/canvas.clientWidth;
   const video=document.querySelector('video').getBoundingClientRect();
   if(video.right>edge-5||video.left<rect.left)throw new Error('Campaign video overlaps sidebar or leaves the viewport');
  });
 }
 if(Math.abs(await page.evaluate(()=>window.__ra2debug.game.speed.value)-23/15)>1e-6)throw new Error('Wrong default campaign speed');
 for(const level of [5,3]) {
  await page.evaluate(()=>window.__ra2debug.gameScreen.menu.open());
  await page.getByText('Options',{exact:true}).click();
  const slider=page.getByRole('slider',{name:'Campaign game speed'});
  await slider.focus();
  await slider.press('Home');
  for(let i=1;i<level;i++)await slider.press('ArrowRight');
  if(await page.evaluate(()=>window.__ra2debug.game.desiredSpeed.value)!==Number.EPSILON)throw new Error('Speed slider unpaused the mission');
  await page.getByText('Back',{exact:true}).click();
  await page.getByText('Resume Mission',{exact:true}).click();
  const expected=(level===5?45:23)/15;
  if(Math.abs(await page.evaluate(()=>window.__ra2debug.game.speed.value)-expected)>1e-6)throw new Error('Campaign speed did not apply on resume');
 }
 // Exercise mouse input and the queued selection/order path, not direct unit tasks.
 await page.evaluate(()=>window.__ra2debug.gameScreen.gameAnimationLoop.start());
 for (const rightClickMove of [true,false]) {
  const before=await page.evaluate(rightClickMove=>{
   const d=window.__ra2debug;
   d.worldInteraction.rightClickMove.value=rightClickMove;
   d.worldInteraction.unitSelectionHandler.deselectAll();
   const unit=d.game.localPlayer.getOwnedObjects().find(u=>u.name==='TANY');
   return {id:unit.id,rx:unit.tile.rx,ry:unit.tile.ry,...d.helpers.getOwnedUnitClickPointById(unit.id)};
  },rightClickMove);
  await page.mouse.click(before.x,before.y-5);
  await page.waitForFunction(id=>window.__ra2debug.helpers.getSelectedUnitIds().includes(id),before.id);
  await page.mouse.click(before.x+(rightClickMove?70:-70),before.y,{button:rightClickMove?'right':'left'});
  await page.waitForFunction(before=>{
   const unit=window.__ra2debug.game.getObjectById(before.id);
   return unit.tile.rx!==before.rx||unit.tile.ry!==before.ry;
  },before,{timeout:10000});
 }
 await page.evaluate(()=>window.__ra2debug.gameScreen.gameAnimationLoop.stop());
 await page.evaluate(()=>{
   const d=window.__ra2debug;const game=d.game;
   for(const b of [...game.getPlayerByName('BadGuy1 House').buildings])if(!b.rules.insignificant)game.destroyObject(b,{player:game.localPlayer});
   for(let i=0;i<200&&!game.campaign.outcome;i++)game.update();
   if(game.campaign.outcome!=='victory')throw new Error('UI game did not reach victory');
   if(d.gameScreen.replay.finishedTick!==game.currentTick)throw new Error('Replay omitted the mission-ending tick');
 });
 await page.screenshot({path:'build/campaign-victory.png'});
 await page.waitForTimeout(5500);
 console.log('After victory',await page.locator('body').innerText());
 await page.getByText('Mission Accomplished',{exact:true}).waitFor();
 await page.getByText('Next Mission',{exact:true}).click();
 await page.getByText('Begin Mission',{exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('video')].some(video=>video.src.includes('/allied-02/brief.mp4')&&video.readyState>=2));
 const bridgeVideo=await page.locator('video[src*="allied-02/brief.mp4"]').evaluate(video=>({src:video.src,controls:video.controls}));
 if(bridgeVideo.controls)throw new Error('Briefing exposed browser controls');
 await page.getByText('Skip Intro',{exact:true}).click();
 await page.waitForFunction(()=>window.__ra2debug?.game?.gameOpts.mapName==='all02s.map',undefined,{timeout:120000});
 const missionTwo=await page.evaluate(()=>{
   const d=window.__ra2debug,g=d.game;
   d.gameScreen.gameAnimationLoop.stop();
   return {map:g.gameOpts.mapName,player:g.localPlayer.name,credits:g.localPlayer.credits,tick:g.currentTick,
      tanya:g.getPlayerByName('Germans').getOwnedObjects().find(u=>u.name==='TANY')?.id};
 });
 if(missionTwo.player!=='Americans'||missionTwo.credits!==10000||!missionTwo.tanya)throw new Error('Mission two did not start with fresh retail state');
 await page.screenshot({path:'build/campaign-mission-two-opening.png'});
 await page.evaluate(()=>window.__ra2debug.gameScreen.gameAnimationLoop.start());
 for (const rightClickMove of [true,false]) {
   const before=await page.evaluate(({rightClickMove,id})=>{
     const d=window.__ra2debug;d.worldInteraction.rightClickMove.value=rightClickMove;
     d.worldInteraction.unitSelectionHandler.deselectAll();
     const unit=d.game.getObjectById(id);
     return {id,rx:unit.tile.rx,ry:unit.tile.ry,...d.helpers.getOwnedUnitClickPointById(id)};
   },{rightClickMove,id:missionTwo.tanya});
   await page.mouse.click(before.x,before.y-5);
   await page.waitForFunction(id=>window.__ra2debug.helpers.getSelectedUnitIds().includes(id),before.id);
   await page.mouse.click(before.x-80,before.y-40,{button:rightClickMove?'right':'left'});
   await page.waitForFunction(before=>{
     const unit=window.__ra2debug.game.getObjectById(before.id);
     return unit.tile.rx!==before.rx||unit.tile.ry!==before.ry;
   },before,{timeout:10000});
 }
 await page.evaluate(async()=>{
   const d=window.__ra2debug;d.gameScreen.gameAnimationLoop.stop();
   const {ScreenType}=await import('/src/gui/screen/ScreenType.ts');
   await d.gameScreen.controller.goToScreenBlocking(ScreenType.MainMenuRoot);
 });
 await page.getByText('Campaign',{exact:true}).waitFor();
 await page.getByText('Campaign',{exact:true}).click();
 await page.getByRole('button',{name:/Red Alert 2 — Allied/}).click();
 const selector=page.getByRole('region',{name:'Allied campaign'});
 await selector.getByText('8% complete',{exact:false}).waitFor();
 await selector.getByRole('button',{name:'Mission One: Lone Guardian — Completed',exact:true}).waitFor();
 if(await selector.locator('button:disabled').count()!==10)throw new Error('Future missions must remain unavailable');
 await page.screenshot({path:'build/campaign-selector.png'});
 await page.getByText('Back',{exact:true}).click();
 await page.getByRole('region',{name:'Campaign selection'}).waitFor();
 await page.getByText('Back',{exact:true}).click();
 await page.reload();
 await page.getByText('Campaign',{exact:true}).click();
 await page.getByRole('button',{name:/Red Alert 2 — Allied/}).click();
 await page.getByRole('region',{name:'Allied campaign'}).getByText('8% complete',{exact:false}).waitFor();
 await page.getByText('Start from Beginning',{exact:true}).click();
 await page.getByText('Begin Mission',{exact:true}).click();
 await page.getByText('Skip Intro',{exact:true}).click();
 await page.waitForFunction(()=>window.__ra2debug?.game?.gameOpts?.mapName==='all01t.map',undefined,{timeout:120000});
 const progress=await page.evaluate(()=>JSON.parse(localStorage.getItem('ra2.alliedCampaign.progress.v1')));
 if(progress.completed.join(',')!=='allied-01')throw new Error('Restart erased completion or credited an unfinished mission');
 writeFileSync('build/campaign-ui-result.json',JSON.stringify({errors,state,mouseOrders:['right','left'],outcome:'victory',bridgeVideo,missionTwo,missionTwoMouseOrders:['right','left'],returnedToMenu:true,selector:{persisted:true,restartPreservedCompletion:true,progress}},null,2));
 if(errors.length)throw new Error('Campaign UI reported JavaScript errors');
} finally {await browser.close();}
