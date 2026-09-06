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
 await page.getByText('Campaign: Mission One',{exact:true}).click();
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
 });
 await page.screenshot({path:'build/campaign-victory.png'});
 await page.waitForTimeout(5500);
 console.log('After victory',await page.locator('body').innerText());
 await page.getByText('Mission Accomplished',{exact:true}).waitFor();
 await page.getByText('Continue',{exact:true}).click();
 await page.getByText('Campaign: Mission One',{exact:true}).waitFor();
 writeFileSync('build/campaign-ui-result.json',JSON.stringify({errors,state,mouseOrders:['right','left'],outcome:'victory',returnedToMenu:true},null,2));
 if(errors.length)throw new Error('Campaign UI reported JavaScript errors');
} finally {await browser.close();}
