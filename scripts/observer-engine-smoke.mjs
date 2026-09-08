// bun scripts/observer-engine-smoke.mjs — requires an asset-seeded dev server.
// Three actual engine pages: two commanders, a pregame observer reused for a late join.
import { chromium } from '../redalert2/node_modules/playwright-core/index.mjs';
import { GameServer } from '../redalert2/src/network/server/GameServer.ts';
import { BunWsTransport } from '../redalert2/server/BunWsTransport.ts';
import { HANDSHAKE_PROTOCOL, ORDERS_PROTOCOL } from '../redalert2/src/network/server/Protocol.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
const longCatchup = process.env.RA2_OBSERVER_LONG_SMOKE === '1';
const finalTicks = longCatchup ? 10000 : 1200;
const base = process.env.RA2_DEV_URL || 'http://127.0.0.1:4000';
const identity = { protocol: HANDSHAKE_PROTOCOL, ordersProtocol: ORDERS_PROTOCOL, engine: 'ra2', mod: 'smoke', version: 'observer-smoke', modHash: 'same-rules', assetFingerprint: 'same-seeded-vfs' };
const transport = new BunWsTransport(0, '127.0.0.1');
const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}), args:['--disable-dev-shm-usage']});
const context = await browser.newContext({viewport:{width:1280,height:900}});
const pages = [], errors = [];
let core, timer, progress;
async function boot() {
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?shell=1`);
  await page.waitForFunction(() => window.__ra2debug?.keyBinds, undefined, {timeout:300000});
  await page.getByText('Skirmish', {exact:true}).click();
  await page.waitForFunction(() => window.__ra2debug?.skirmishLobby?.gameOpts, undefined, {timeout:120000});
  return page;
}
async function connect(page, name, role, cap = 600) {
  await page.evaluate(async ({identity,address,name,role,cap}) => {
    const { LobbyClient } = await import('/src/network/client/LobbyClient.ts');
    const controller = window.__ra2debug.mainMenuController.getCurrentScreen().rootController;
    const probe = window.__observerSmoke = {cap,role,hashes:[],chat:[],errors:[],paused:false,peakBufferedFrames:0,suppressedTicks:0};
    const { NetworkMatchSession } = await import('/src/network/client/NetworkMatchSession.ts');
    const receiveHistory=NetworkMatchSession.prototype.receiveHistory;
    NetworkMatchSession.prototype.receiveHistory=function(message) {
      const result=receiveHistory.call(this,message);
      probe.peakBufferedFrames=Math.max(probe.peakBufferedFrames,this.getSnapshot().bufferedTicks.length);
      return result;
    };
    const { NetworkTurnManager } = await import('/src/network/client/NetworkTurnManager.ts');
    const turn = NetworkTurnManager.prototype.doGameTurn;
    NetworkTurnManager.prototype.doGameTurn = function(timestamp) {
      return this.game.currentTick >= probe.cap || probe.paused ? false : turn.call(this,timestamp);
    };
    // Record the real simulation after each update, including accelerated history playback.
    const { Game } = await import('/src/game/Game.ts');
    const update = Game.prototype.update;
    Game.prototype.update = function(...args) {
      if (role==='observer') {
        probe.catchupStarted ??= performance.now();
        if (window.__ra2debug.gameScreen?.sound?.gameplaySuppressed) probe.suppressedTicks++;
      }
      const result = update.apply(this,args);
      probe.hashes.push({tick:this.currentTick,hash:this.getHash()});
      if (role==='observer' && this.currentTick>=probe.cap) probe.catchupMillis=performance.now()-probe.catchupStarted;
      return result;
    };
    const client = probe.client = new LobbyClient();
    client.onError.subscribe(error => probe.errors.push({code:error.code,message:error.message}));
    client.onChat.subscribe(message => probe.chat.push(message));
    client.onStartGame.subscribe(() => {
      probe.match = client.getMatchSession();
      controller.goToScreen(1,{create:true,lanLaunch:probe.match.getLaunchDescriptor(),lanMatchSession:probe.match});
    });
    await client.connect(address,{...identity,type:'hello',name,role});
    client.command('map_ready',{digest:client.session.gameOpts.mapDigest});
    if (role === 'player') {
      const self = client.session.clients.find(member => member.id === client.clientId);
      client.command('player',{slotIndex:self.slotIndex,teamId:self.slotIndex,colorId:self.slotIndex,countryId:0,startPos:self.slotIndex});
      client.command('state',{ready:true,mapDigest:client.session.gameOpts.mapDigest});
    } else if (client.session.state === 'started') client.observeGame();
  },{identity,address:`127.0.0.1:${transport.port}`,name,role,cap});
}
async function drive(page) {
  await page.waitForFunction(() => window.__ra2debug?.gameScreen?.gameTurnMgr && (window.__observerSmoke.role!=='observer' || window.__ra2debug.gameScreen.gameAnimationLoop?.isStarted),undefined,{timeout:180000});
  await page.evaluate(() => {
    const screen = window.__ra2debug.gameScreen, probe = window.__observerSmoke;
    if (probe.role==='observer') {
      if (!screen.gameAnimationLoop.isStarted) throw new Error('Observer animation loop is not running');
      return;
    }
    screen.gameAnimationLoop.stop();
    probe.driver = setInterval(() => {
      if (probe.paused) return;
      for (let i=0;i<8 && window.__ra2debug.game.currentTick<probe.cap;i++) if (!screen.gameTurnMgr.doGameTurn(performance.now())) break;
    },4);
  });
}
async function at(page,tick) {
  await page.waitForFunction(tick => window.__ra2debug?.game?.currentTick>=tick,tick,{timeout:180000});
}
async function compare(a,b,through) {
  const read = page => page.evaluate(through => window.__observerSmoke.hashes.filter(entry=>entry.tick<=through),through);
  const [left,right] = await Promise.all([read(a),read(b)]);
  if (left.length !== through || JSON.stringify(left)!==JSON.stringify(right)) throw new Error(`Engine history mismatch through ${through}: ${left.length}/${right.length}`);
}
try {
  progress = setInterval(async () => console.log('[observer smoke]', await Promise.all(pages.filter(p=>!p.isClosed()).map(p=>p.evaluate(()=>({tick:window.__ra2debug?.game?.currentTick,fatal:window.__observerSmoke?.match?.fatalError,errors:window.__observerSmoke?.errors}))))),30000);
  const host = await boot(), guest = await boot();
  let observer = await boot();
  const gameOpts = await host.evaluate(async (longCatchup) => {
    const screen=window.__ra2debug.mainMenuController.getCurrentScreen();
    const {Engine}=await import('/src/engine/Engine.ts');
    const map=screen.mapList.getAll().filter(map=>map.official&&map.maxSlots>=4&&Engine.vfs.fileExists(map.fileName)).sort((a,b)=>a.fileName.localeCompare(b.fileName))[0];
    if (!map) throw new Error('No official four-slot map');
    screen.pregameController.applyMapSelection({gameMode:screen.gameModes.getById(screen.pregameController.getGameOpts().gameMode),mapName:map.fileName,changedMapFile:await Engine.vfs.openFileWithRfs(map.fileName)});
    const opts=screen.pregameController.getGameOpts();
    opts.aiPlayers=Array.from({length:opts.maxSlots},(_,i)=>!longCatchup&&i>=2?{difficulty:2,countryId:-2,colorId:-2,startPos:-2,teamId:-2}:undefined);
    opts.disconnectAi=true;
    return opts;
  },longCatchup);
  core=new GameServer({identity,gameOpts,allowSpectators:true,slotsInfo:Array.from({length:gameOpts.maxSlots},(_,i)=>({type:i<2?1:longCatchup?0:4})),orderLatency:2,now:Date.now,random:()=>0.125},transport);
  await core.start(); timer=setInterval(()=>core.tick(),1000);
  await connect(host,'Commander 1','player');
  await connect(guest,'Commander 2','player');
  await connect(observer,'Watcher','observer');
  await Promise.all([host,guest].map(page=>page.evaluate(()=>{const client=window.__observerSmoke.client;client.command('state',{ready:true,mapDigest:client.session.gameOpts.mapDigest});})));
  await host.waitForFunction(()=>window.__observerSmoke.client.session.clients.length===3&&window.__observerSmoke.client.session.clients.filter(c=>c.role==='player').every(c=>c.ready&&c.mapReady));
  await host.evaluate(()=>window.__observerSmoke.client.command('startgame'));
  await Promise.all([host,guest,observer].map(drive));
  await Promise.all([host,guest,observer].map(page=>at(page,600)));
  await compare(host,guest,600); await compare(host,observer,600);
  for (const page of [host,guest,observer]) {
    const setupErrors=await page.evaluate(()=>window.__observerSmoke.errors);
    if(setupErrors.length) throw new Error(`Setup server errors: ${JSON.stringify(setupErrors)}`);
  }
  // Observer UI has only its own audience, including Backspace, Tab and slash whispers.
  await observer.keyboard.press('Backspace');
  const input=observer.locator('.game-chat-input input');
  await input.waitFor({state:'visible'});
  await observer.keyboard.press('Tab');
  if (!(await observer.locator('.game-chat-input label').innerText()).includes('Observers')) throw new Error('Observer composer escaped its audience: '+JSON.stringify(await observer.evaluate(()=>({label:document.querySelector('.game-chat-input label')?.textContent,observerChat:window.__ra2debug.gameScreen.hud.messageList.observerChat,isObserver:window.__observerSmoke.match.isObserver(),role:window.__observerSmoke.client.session.clients.find(c=>c.id===window.__observerSmoke.client.clientId)?.role}))));
  await input.fill('/w Commander_1 literal text');
  if (!(await observer.locator('.game-chat-input label').innerText()).includes('Observers')) throw new Error('Slash whisper escaped observer audience');
  await input.fill('observer-secret'); await observer.keyboard.press('Enter');
  await host.evaluate(()=>window.__observerSmoke.client.chat('all-visible','all'));
  await host.evaluate(()=>window.__observerSmoke.client.chat('team-one','team'));
  await guest.evaluate(()=>window.__observerSmoke.client.chat('team-two','team'));
  await observer.waitForFunction(()=>['observer-secret','all-visible','team-one','team-two'].every(text=>window.__observerSmoke.chat.some(message=>message.text===text)));
  for (const [page,forbidden] of [[host,['observer-secret','team-two']],[guest,['observer-secret','team-one']]]) {
    if (await page.evaluate(forbidden=>window.__observerSmoke.chat.some(message=>forbidden.includes(message.text)),forbidden)) throw new Error('Chat audience leak');
  }
  await observer.keyboard.press('Enter');
  const history=observer.locator('.game-chat-history');
  for (const badge of ['[Observers]','[All]','[Team 1]','[Team 2]']) if (!(await history.innerText()).includes(badge)) throw new Error(`Missing chat badge ${badge}`);
  await observer.keyboard.press('Escape');
  await observer.evaluate(()=>{
    const history=window.__ra2debug.gameScreen.hud.chatHistory.getAll();
    for (const text of ['team-one','team-two']) {
      const message=history.find(message=>message.text===text);
      const expected=window.__ra2debug.game.getPlayerByName(message.from).color.asHexString();
      if(message.senderColor!==expected) throw new Error('Chat sender player color mismatch');
    }
  });
  // A waiting member has no game page or observer privileges.
  await host.evaluate(async ({address,identity})=>{
    const {LobbyClient}=await import('/src/network/client/LobbyClient.ts');
    const waiter=window.__observerSmoke.waiter=new LobbyClient();
    window.__observerSmoke.waiterChat=[];
    waiter.onChat.subscribe(message=>window.__observerSmoke.waiterChat.push(message));
    await waiter.connect(address,{...identity,type:'hello',name:'Waiting commander'});
  },{address:`127.0.0.1:${transport.port}`,identity});
  await observer.evaluate(()=>{window.__observerSmoke.paused=true; window.__observerSmoke.client.chat('observer-waiter-secret','observers');});
  await Promise.all([host,guest].map(page=>page.evaluate(()=>{window.__observerSmoke.cap=700;})));
  await Promise.all([host,guest].map(page=>at(page,700)));
  if (await host.evaluate(()=>window.__observerSmoke.waiterChat.some(message=>message.text==='observer-waiter-secret'))) throw new Error('Waiting player received observer chat');
  await observer.close();
  // Drop after the retained-history prefix: late observers must replay AI takeover too.
  if (!longCatchup) await guest.evaluate(()=>window.__observerSmoke.client.close());
  const continuing=longCatchup?[host,guest]:[host];
  await Promise.all(continuing.map(page=>page.evaluate(ticks=>{window.__observerSmoke.cap=ticks;},finalTicks)));
  await Promise.all(continuing.map(page=>at(page,finalTicks)));
  if(longCatchup) await compare(host,guest,finalTicks);
  observer=await boot();
  await connect(observer,'Late watcher','observer',finalTicks); await drive(observer); await at(observer,finalTicks);
  await compare(host,observer,finalTicks);
  if (errors.length) throw new Error(`Browser errors: ${JSON.stringify(errors)}`);
  const result=await observer.evaluate(()=>({ticks:window.__ra2debug.game.currentTick,hash:window.__ra2debug.game.getHash(),errors:window.__observerSmoke.errors,fatal:window.__observerSmoke.match.fatalError,catchupMillis:window.__observerSmoke.catchupMillis,peakBufferedFrames:window.__observerSmoke.peakBufferedFrames,suppressedTicks:window.__observerSmoke.suppressedTicks}));
  if (!result.suppressedTicks || result.peakBufferedFrames>64) throw new Error(`Catch-up did not suppress gameplay sound or exceeded frame budget: ${JSON.stringify(result)}`);
  if (result.errors.length||result.fatal) throw new Error(`Observer errors: ${JSON.stringify(result)}`);
  mkdirSync('build',{recursive:true});writeFileSync(longCatchup?'build/observer-long-smoke.json':'build/observer-engine-smoke.json',JSON.stringify(result,null,2));
  console.log(`Observer pregame, chat badges/isolation, paused-observer independence, late history${longCatchup?'':' and AI takeover'} passed through ${finalTicks} ticks`);
} finally {
  clearInterval(progress);clearInterval(timer);core?.stop();transport.close();await browser.close();
}
