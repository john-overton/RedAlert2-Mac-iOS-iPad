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
 writeFileSync('build/campaign-ui-result.json',JSON.stringify({errors,state,outcome:'victory',returnedToMenu:true},null,2));
 if(errors.length)throw new Error('Campaign UI reported JavaScript errors');
} finally {await browser.close();}
