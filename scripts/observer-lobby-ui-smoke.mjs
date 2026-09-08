// bun scripts/observer-lobby-ui-smoke.mjs — production lobby and observer navigation.
import assert from 'node:assert/strict';
import { chromium } from '../redalert2/node_modules/playwright-core/index.mjs';
import { GameServer } from '../redalert2/src/network/server/GameServer.ts';
import { BunWsTransport } from '../redalert2/server/BunWsTransport.ts';
import { connectPersistentUi } from './network-persistent-ui-smoke.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.env.RA2_DEV_URL || 'http://127.0.0.1:4001';
const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const context = await browser.newContext({viewport:{width:1280,height:900}});
const transport = new BunWsTransport(0,'127.0.0.1');
const pages = [], errors = [];
let core, timer;
async function room(page) { await page.locator('.multiplayer-lobby').waitFor({state:'visible',timeout:30000}); }
async function at(page,tick=100) { await page.waitForFunction(tick=>window.__ra2debug?.game?.currentTick>=tick,tick,{timeout:120000}); }
async function returnObserver(page) {
  await page.locator('.observer-catchup button').click(); await room(page);
}
async function reconnect(page, role) {
  await page.getByText('Leave Server',{exact:true}).click();
  await page.getByLabel('Join as',{exact:true}).selectOption(role);
  await page.evaluate(async()=>{
    const probe=window.__networkSmoke, screen=probe.roomScreen;
    await screen.connect(false);
    if (!screen.client?.session) throw new Error(screen.error || 'Reconnect failed');
    probe.client=screen.client;
    probe.client.onError.subscribe(error=>probe.errors.push(error.message));
    probe.client.onStartGame.subscribe(()=>{probe.match=probe.client.getMatchSession();probe.launches++;probe.hashes=[];});
  });
  await room(page);
  await page.waitForFunction(()=>window.__networkSmoke.client.session.clients.find(c=>c.id===window.__networkSmoke.client.clientId)?.mapReady);
}
try {
  for(let i=0;i<3;i++) {
    const page=await context.newPage();pages.push(page);
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${base}/?shell=1`);
    await page.waitForFunction(()=>window.__ra2debug?.keyBinds,undefined,{timeout:300000});
    await page.getByText('Skirmish',{exact:true}).click();
    await page.waitForFunction(()=>window.__ra2debug?.skirmishLobby?.gameOpts,undefined,{timeout:120000});
    await page.evaluate(async()=>{
      const {NetworkTurnManager}=await import('/src/network/client/NetworkTurnManager.ts');
      const turn=NetworkTurnManager.prototype.doGameTurn;
      window.__networkSmoke={cap:100,hashes:[],errors:[],launches:0};
      NetworkTurnManager.prototype.doGameTurn=function(t){
        const probe=window.__networkSmoke;
        if(this.game.currentTick>=probe.cap)return false;
        const advanced=turn.call(this,t);
        if(advanced)probe.hashes.push({tick:this.game.currentTick,hash:this.game.getHash()});
        return advanced;
      };
    });
  }
  const [host,guest,observer]=pages;
  const opts=await host.evaluate(async()=>{
    const screen=window.__ra2debug.mainMenuController.getCurrentScreen();
    const {Engine}=await import('/src/engine/Engine.ts');
    const entry=screen.mapList.getAll().filter(m=>m.official&&m.maxSlots>=4&&Engine.vfs.fileExists(m.fileName)).sort((a,b)=>a.fileName.localeCompare(b.fileName))[0];
    screen.pregameController.applyMapSelection({gameMode:screen.gameModes.getById(screen.pregameController.getGameOpts().gameMode),mapName:entry.fileName,changedMapFile:await Engine.vfs.openFileWithRfs(entry.fileName)});
    const opts=screen.pregameController.getGameOpts();opts.aiPlayers=Array.from({length:opts.maxSlots},()=>undefined);return opts;
  });
  await host.exposeFunction('__persistentHostGame',async options=>{
    core=new GameServer({...options,orderLatency:2},transport);await core.start();
    return {port:transport.port,addresses:['127.0.0.1']};
  });
  await host.exposeFunction('__persistentStopHosting',()=>core?.stop());
  timer=setInterval(()=>core?.tick(),1000);
  for(let i=0;i<3;i++)await connectPersistentUi(pages[i],i,opts,transport.port);
  await observer.getByLabel('Your role',{exact:true}).selectOption('observer');
  await observer.waitForFunction(()=>window.__networkSmoke.client.session.clients.find(c=>c.id===window.__networkSmoke.client.clientId)?.role==='observer');
  assert.equal(core.session.gameOpts.humanPlayers.length,2);
  assert.equal(core.session.clients[2].slotIndex,null);
  for(let slot=2;slot<opts.maxSlots;slot++)await host.evaluate(slot=>window.__networkSmoke.client.command('slot_close',{slotIndex:slot}),slot);
  await reconnect(observer,'observer');
  assert.equal(core.session.clients.length,3);
  console.log('Role selection and observer join into full commander room passed');
  for(const page of [host,guest])await page.locator('.multiplayer-lobby button').filter({hasText:/^Ready$/}).click();
  await host.getByText('Start Game',{exact:true}).click();
  await Promise.all(pages.map(page=>at(page)));
  const hashes=await Promise.all(pages.map(page=>page.evaluate(()=>window.__networkSmoke.hashes)));
  assert.deepEqual(hashes[0],hashes[1]);assert.deepEqual(hashes[0],hashes[2]);
  assert.equal(hashes[0].length,100);
  assert.equal(await observer.evaluate(()=>window.__ra2debug.localPlayer.isObserver),true);
  const first=await observer.evaluate(()=>({id:window.__networkSmoke.client.clientId,attempt:window.__networkSmoke.match.start.observationId}));
  await returnObserver(observer);
  await observer.getByText('Observe Game',{exact:true}).click();
  await at(observer);
  const second=await observer.evaluate(()=>({id:window.__networkSmoke.client.clientId,attempt:window.__networkSmoke.match.start.observationId,hashes:window.__networkSmoke.hashes}));
  assert.equal(second.id,first.id);assert.ok(second.attempt>first.attempt);assert.deepEqual(second.hashes,hashes[0]);
  await returnObserver(observer);
  await reconnect(observer,'player');
  assert.equal(await observer.evaluate(()=>window.__networkSmoke.client.session.clients.find(c=>c.id===window.__networkSmoke.client.clientId).role),'waiting');
  await observer.getByText('Wait in Lobby',{exact:true}).click();
  assert.equal(await observer.evaluate(()=>Boolean(window.__ra2debug.gameScreen)),false);
  await observer.getByText('Observe Game',{exact:true}).click();
  await at(observer);
  assert.deepEqual(await observer.evaluate(()=>window.__networkSmoke.hashes),hashes[0]);
  console.log('Same-generation retry and running-room Observe Game / Wait in Lobby passed');
  for(const page of [host,guest])await page.evaluate(()=>{
    const screen=window.__ra2debug.gameScreen;screen.menu.onQuit.dispatch(screen.menu);
  });
  await room(observer);
  assert.equal(core.session.state,'waiting');
  for(const page of [host,guest]) {
    await page.getByText('Continue',{exact:true}).click();await room(page);
  }
  assert.ok(core.session.clients.every(c=>!c.ready));
  assert.equal(await host.evaluate(()=>window.__networkSmoke.stopCalls),0);
  for(const page of pages)await page.evaluate(()=>{window.__networkSmoke.hashes=[];});
  for(const page of [host,guest])await page.locator('.multiplayer-lobby button').filter({hasText:/^Ready$/}).click();
  await host.getByText('Start Game',{exact:true}).click();
  await Promise.all(pages.map(page=>at(page)));
  const round2=await Promise.all(pages.map(page=>page.evaluate(()=>window.__networkSmoke.hashes)));
  assert.deepEqual(round2[0],round2[1]);assert.deepEqual(round2[0],round2[2]);
  assert.equal(core.session.generation,2);
  // End the round while an observer is still inside the asynchronous loader.
  await returnObserver(observer);
  await observer.evaluate(async()=>{
    const {GameLoader}=await import('/src/gui/screen/game/GameLoader.ts');
    const original=GameLoader.prototype.load;
    GameLoader.prototype.load=async function(...args){
      window.__observerLoadWaiting=true;
      await new Promise(resolve=>{window.__releaseObserverLoad=resolve;});
      GameLoader.prototype.load=original;
      return original.apply(this,args);
    };
  });
  await observer.getByText('Observe Game',{exact:true}).click();
  await observer.waitForFunction(()=>window.__observerLoadWaiting);
  for(const page of [host,guest])await page.evaluate(()=>{
    const screen=window.__ra2debug.gameScreen;screen.menu.onQuit.dispatch(screen.menu);
  });
  await room(observer);
  await observer.evaluate(()=>window.__releaseObserverLoad());
  await observer.waitForTimeout(500);
  await room(observer);
  assert.equal(core.session.state,'waiting');
  assert.equal(await observer.evaluate(()=>Boolean(window.__ra2debug.gameScreen)),false);
  console.log('Match end during observer loading cancels launch and preserves the room');
  assert.deepEqual(errors,[]);
  for(const page of pages)assert.deepEqual(await page.evaluate(()=>window.__networkSmoke.errors),[]);
  mkdirSync('build/multiplayer-observers',{recursive:true});
  writeFileSync('build/multiplayer-observers/observer-lobby-ui.json',JSON.stringify({first,second,hashes,round2},null,2));
  console.log('Observers returned to the same room and joined round two; all 100 hashes match');
} catch(error) {
  console.error('Observer UI failure',await Promise.all(pages.map(page=>page.evaluate(()=>({screen:window.__ra2debug?.mainMenuController?.getCurrentScreen()?.constructor.name,tick:window.__ra2debug?.game?.currentTick,error:window.__networkSmoke?.roomScreen?.error,errors:window.__networkSmoke?.errors,session:window.__networkSmoke?.client?.session,fatal:window.__networkSmoke?.match?.fatalError})).catch(()=>({closed:true})))));
  throw error;
} finally {clearInterval(timer);core?.stop();transport.close();await browser.close();}
