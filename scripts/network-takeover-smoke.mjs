export async function checkTakeover(pages, targetTicks, policy) {
 const survivors=pages.slice(0,2), departing=pages[2];
 // All three start synchronized. Keep the third client alive but stop its turns.
 const initial=await Promise.all(pages.map(page=>page.evaluate(()=>window.__networkSmoke.hashes)));
 if(initial.some(h=>JSON.stringify(h)!==JSON.stringify(initial[0])))throw new Error('Initial hashes differ');
 for(const page of survivors)await page.evaluate(cap=>{
  window.__networkSmoke.cap=cap;
  const game=window.__ra2debug.game, manager=game.botManager, original=manager.takeOverPlayer;
  manager.takeOverPlayer=function(player,game){
   const before={credits:player.credits,ids:player.getOwnedObjects().map(o=>o.id)};
   original.call(this,player,game);
   window.__networkSmoke.takeover={before,after:{credits:player.credits,ids:player.getOwnedObjects().map(o=>o.id)},tick:game.currentTick};
  };
 },targetTicks+300);
 await survivors[0].locator('.network-stall-panel').waitFor({state:'visible',timeout:15000});
 await survivors[1].locator('.network-stall-panel').waitFor({state:'visible',timeout:15000});
 if(await survivors[1].locator('.network-stall-panel button').count())throw new Error('Guest has host controls');
 const kick=survivors[0].locator('.network-stall-player').filter({hasText:'Smoke 3'}).getByRole('button',{name:'Kick & replace with AI'});
 await kick.waitFor({state:'visible',timeout:15000});
 await survivors[0].getByRole('button',{name:'Keep waiting'}).click();
 await survivors[0].screenshot({path:'build/macos/network-stall-host.png'});
 await survivors[1].screenshot({path:'build/macos/network-stall-guest.png'});
 if(!policy) {
  // First let the connection recover naturally, then stall it a second time.
  for(const page of pages)await page.evaluate(cap=>window.__networkSmoke.cap=cap,targetTicks+50);
  await Promise.all(pages.map(page=>page.waitForFunction(cap=>window.__ra2debug.game.currentTick>=cap,targetTicks+50)));
  await Promise.all(survivors.map(page=>page.locator('.network-stall-panel').waitFor({state:'hidden'})));
  for(const page of survivors)await page.evaluate(cap=>window.__networkSmoke.cap=cap,targetTicks+300);
  await kick.waitFor({state:'visible',timeout:15000});
 }
 if(policy) {
  // Exercise the real in-game Quit handler, including its legacy resign bypass.
  await departing.evaluate(()=>window.__ra2debug.gameScreen.menu.onQuit.dispatch(window.__ra2debug.gameScreen.menu));
 } else await kick.click();
 await Promise.all(survivors.map(page=>page.waitForFunction(cap=>window.__ra2debug.game.currentTick>=cap,targetTicks+300,{timeout:120000})));
 const states=await Promise.all(survivors.map(page=>page.evaluate(()=>{
  const g=window.__ra2debug.game,p=g.getPlayerByName('Smoke 3');
  return {hashes:window.__networkSmoke.hashes,transition:window.__networkSmoke.takeover,isAi:p.isAi,dropped:p.dropped,
   assets:p.getOwnedObjects().length,bot:g.botManager.bots.has(p),difficulty:p.aiDifficulty,replayControls:window.__ra2debug.gameScreen.replay?.actionRecords.filter(a=>a.actionType===14||a.actionType===15),errors:window.__networkSmoke.errors};
 })));
 if(JSON.stringify(states[0].hashes)!==JSON.stringify(states[1].hashes))throw new Error('AI/drop transition desynchronized survivors');
 for(const state of states) {
  if(state.replayControls?.length!==1 || state.replayControls[0].actionType!==(policy==='destroy'?15:14))throw new Error('Disconnect control action missing from replay');
  if(state.errors.length)throw new Error(JSON.stringify(state.errors));
  if(policy==='destroy') {if(state.isAi||!state.dropped||state.assets)throw new Error('Disconnect did not destroy assets');}
  else {
   if(!state.isAi||!state.bot||state.difficulty!==4||!state.assets)throw new Error('Normal AI did not retain the army');
   if(JSON.stringify(state.transition.before)!==JSON.stringify(state.transition.after))throw new Error('Takeover altered existing assets or credits');
  }
 }
 await Promise.all(survivors.map(page=>page.locator('.network-stall-panel').waitFor({state:'hidden'})));
 console.log(`${policy??'host kick'}: stall UI, host-only attribution/controls, recovery and ${states[0].hashes.length} matching ticks passed`);
}
