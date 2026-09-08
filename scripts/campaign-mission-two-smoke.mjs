import { campaignTestConfig } from './campaign-test-config.mjs';
// Requires the local Vite dev server and locally imported mission-two assets.
// Opening/final combat cleanup and the isolated transport case are controlled fixtures.
import { chromium } from '../redalert2/node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
try {
 const page = await browser.newPage();
 let errors = 0;
 page.on('pageerror', e => { if (++errors < 5) console.error(e.message); });
 await page.route('**/config.ini*', route => route.fulfill({body:campaignTestConfig(), contentType:'text/plain'}));
 await page.goto(`${process.env.RA2_DEV_URL ?? 'http://127.0.0.1:4000'}/?shell=1`);
 await page.waitForFunction(() => window.__ra2debug?.keyBinds, undefined, {timeout:120000});
 console.log('Engine booted');
 const text = readFileSync(join(root, 'campaign-export/ra2/allied-02/all02s.map'),'utf8');
 const result = await page.evaluate(async text => {
  const {Engine} = await import('/src/engine/Engine.ts');
  const {CampaignScenario} = await import('/src/data/campaign/CampaignScenario.ts');
  const {IniFile} = await import('/src/data/IniFile.ts');
  const {MapFile} = await import('/src/data/MapFile.ts');
  const {GameFactory} = await import('/src/game/GameFactory.ts');
  const {TileSets} = await import('/src/game/theater/TileSets.ts');
  const {BoxedVar} = await import('/src/util/BoxedVar.ts');
  const {TestToolSupport} = await import('/src/tools/TestToolSupport.ts');
  const scenario = new CampaignScenario(new IniFile(text));
  const map = new MapFile(text);
  await TestToolSupport.ensureTheater(map.theaterType);
  await Engine.loadTheater(map.theaterType);
  const engine = Engine.getActiveEngine();
  const sets = new TileSets(Engine.getTheaterIni(engine,map.theaterType));
  sets.loadTileData(Engine.getTileData(), Engine.getTheaterSettings(engine,map.theaterType).extension);
  const modes = Engine.getMpModes();
  const opts = {gameMode:modes.getAll()[0].id,gameSpeed:5,credits:100,unitCount:0,shortGame:false,superWeapons:true,buildOffAlly:false,mcvRepacks:false,cratesAppear:false,destroyableBridges:true,multiEngineer:false,noDogEngiKills:false,mapName:'all02s.map',mapTitle:'Eagle Dawn',mapDigest:'',mapSizeBytes:text.length,maxSlots:8,mapOfficial:true,humanPlayers:[{name:'Americans',countryId:0,colorId:0,startPos:0,teamId:0}],aiPlayers:[]};
  window.__createCampaignGame=()=>{
    const game=GameFactory.create(map,sets,Engine.getRules(),Engine.getArt(),Engine.getAi(),new IniFile(),[],'campaign-test',1,opts,modes,true,{},undefined,new BoxedVar(false),new BoxedVar(0),undefined,scenario);
  game.init(game.getPlayerByName('Americans'));
    return game;
  };
  const game=window.__createCampaignGame();
  const expectedObjects = [...map.structures, ...map.vehicles, ...map.infantries, ...map.aircrafts];
  for (const house of scenario.houses) {
    const player = game.getPlayerByName(house.id);
    const expected = expectedObjects.filter(object => object.owner === house.id && object.health > 0);
    if (player.getOwnedObjects().length !== expected.length) throw new Error(`Object count for ${house.id}: ${player.getOwnedObjects().length} / ${expected.length}`);
    if (player.credits !== Number(house.properties.Credits) * 100) throw new Error(`Wrong credits for ${house.id}`);
    for (const other of scenario.houses) {
      if (other.id === house.id) continue;
      const allied = (house.properties.Allies ?? '').split(',').includes(other.id);
      if (game.alliances.areAllied(player, game.getPlayerByName(other.id)) !== allied) throw new Error(`Wrong alliance ${house.id} -> ${other.id}`);
    }
  }
  const human = game.getPlayerByName(scenario.playerHouse.id);
  if (!game.getAllPlayers().some(p => p.getOwnedObjects().some(object => object.name === 'TANY'))) throw new Error('Tanya did not spawn');
  if (human.radarTrait.isDisabled()) throw new Error('Free radar not active');
  Error.stackTraceLimit=30;
  const deaths=[];
  const {EventType}=await import('/src/game/event/EventType.ts');
  game.events.subscribe(e=>{if(e.type===EventType.ObjectDestroy && e.target.isTechno()) deaths.push({tick:game.currentTick,name:e.target.name,owner:e.target.owner?.name,attacker:e.attackerInfo?.player?.name,incidental:e.incidental});});
  game.start();
  window.__campaignTestGame = game;
  for (let i=0;i<1500;i++) game.update();
  return {objects:game.getAllPlayers().flatMap(p=>p.getOwnedObjects().map(u=>({id:u.id,name:u.name,owner:p.name,x:u.tile.rx,y:u.tile.ry,hp:u.healthTrait.health}))),deaths, outcome:game.campaign.outcome, locked:game.campaign.inputLocked,tick:game.currentTick, teams:game.campaign.teams.active.map(t=>({id:t.id,line:t.line,members:t.members.map(u=>u.name)})), fired:[...game.campaign.firedTriggers], countries:game.getAllPlayers().map(p=>({name:p.name,country:p.country.name,id:p.country.id,credits:p.credits,objects:p.getOwnedObjects().length})),camera:game.campaign.initialCameraPosition(), expected:map.structures.length+map.vehicles.length+map.infantries.length+map.aircrafts.length};
 },text);
 if(result.deaths.some(death=>death.name==='ENGINEER'))throw new Error('An opening engineer was killed');
 const regressions = await page.evaluate(async()=>{
  const {ActionFactory}=await import('/src/game/action/ActionFactory.ts');
  const {ActionFactoryReg}=await import('/src/game/action/ActionFactoryReg.ts');
  const {ActionType}=await import('/src/game/action/ActionType.ts');
  const {OrderType}=await import('/src/game/order/OrderType.ts');
  const {ObjectType}=await import('/src/engine/type/ObjectType.ts');
  const fresh=window.__createCampaignGame();fresh.start();
  for(let i=0;i<1500;i++)fresh.update();
  const objects=()=>fresh.getAllPlayers().flatMap(p=>p.getOwnedObjects());
  const rock=fresh.createUnitForPlayer(fresh.rules.getObject('JUMPJET',ObjectType.Infantry),fresh.getPlayerByName('Alliance'));
  const frenchEngineer=fresh.createUnitForPlayer(fresh.rules.getObject('ENGINEER',ObjectType.Infantry),fresh.getPlayerByName('French'));
  const sentries=objects().filter(u=>u.name==='NALASR');
  for(const sentry of sentries) {
    if(fresh.areFriendly(rock,sentry))continue;
    if(!rock.attackTrait.selectWeaponVersus(rock,sentry,fresh,false))throw new Error(`Rocketeer cannot target ${sentry.owner.name} sentry`);
  }
  if(rock.attackTrait.selectWeaponVersus(rock,frenchEngineer,fresh,false))throw new Error('Rocketeer targets friendly engineer');
  const chapel=objects().find(u=>u.name==='CACOLO01');
  // Start an American engineer beside the chapel to test actual pathing/entry,
  // before the scripted French capture team can reach it.
  const engineer=fresh.createUnitForPlayer(fresh.rules.getObject('ENGINEER',ObjectType.Infantry),fresh.localPlayer);
  const {RadialTileFinder}=await import('/src/game/map/tileFinder/RadialTileFinder.ts');
  const spawnTile=new RadialTileFinder(fresh.map.tiles,fresh.map.mapBounds,chapel.tile,chapel.getFoundation(),1,4,t=>fresh.map.terrain.getPassableSpeed(t,engineer.rules.speedType,true,false)>0&&!fresh.map.getGroundObjectsOnTile(t).some(o=>o.isTechno())).getNextTile();
  fresh.spawnObject(engineer,spawnTile);
  for(let i=0;i<2;i++)fresh.update(); // Reveal the nearby target before issuing a player order.
  const factory=new ActionFactory();new ActionFactoryReg().register(factory,fresh);
  const select=factory.create(ActionType.SelectUnits);select.player=fresh.localPlayer;select.unitIds=[engineer.id];select.process();
  const action=factory.create(ActionType.OrderUnits);action.player=fresh.localPlayer;action.orderType=OrderType.Capture;action.target=fresh.createTarget(chapel,chapel.tile);action.process();
  for(let i=0;i<500&&chapel.owner!==fresh.localPlayer&&!fresh.campaign.outcome;i++)fresh.update();
  fresh.update();
  if(chapel.owner!==fresh.localPlayer||fresh.campaign.outcome||!fresh.campaign.firedTriggers.has('0926B97C'))
    throw new Error('American chapel capture failed '+JSON.stringify({owner:chapel.owner.name,engineer:{x:engineer.tile.rx,y:engineer.tile.ry,hp:engineer.healthTrait.health,spawned:engineer.isSpawned},locked:fresh.campaign.inputLocked,outcome:fresh.campaign.outcome,fired:[...fresh.campaign.firedTriggers]}));
  const captureTick=fresh.currentTick;
  const sentry=sentries.find(u=>u.owner.name==='Confederation');
  const rockTile=new RadialTileFinder(fresh.map.tiles,fresh.map.mapBounds,sentry.tile,sentry.getFoundation(),1,3,t=>fresh.map.terrain.getPassableSpeed(t,rock.rules.speedType,true,false)>0&&!fresh.map.getGroundObjectsOnTile(t).some(o=>o.isTechno())).getNextTile();
  fresh.spawnObject(rock,rockTile);
  fresh.update();fresh.update();
  const hpBefore=sentry.healthTrait.health;
  const selectRock=factory.create(ActionType.SelectUnits);selectRock.player=fresh.localPlayer;selectRock.unitIds=[rock.id];selectRock.process();
  const attack=factory.create(ActionType.OrderUnits);attack.player=fresh.localPlayer;attack.orderType=OrderType.Attack;attack.target=fresh.createTarget(sentry,sentry.tile);attack.process();
  for(let i=0;i<300&&sentry.healthTrait.health>=hpBefore;i++)fresh.update();
  if(sentry.healthTrait.health>=hpBefore)throw new Error('Rocketeer attack did not damage Confederate sentry');
  const result={sentriesTargetable:sentries.length,americanChapelCapturedAt:captureTick,sentryDamage:hpBefore-sentry.healthTrait.health,outcome:fresh.campaign.outcome};
  fresh.dispose();return result;
 });
 const runtime = await page.evaluate(async()=>{
  const game=window.__campaignTestGame;
  const {ActionFactory}=await import('/src/game/action/ActionFactory.ts');
  const {ActionFactoryReg}=await import('/src/game/action/ActionFactoryReg.ts');
  const {ActionType}=await import('/src/game/action/ActionType.ts');
  const {OrderType}=await import('/src/game/order/OrderType.ts');
  const factory=new ActionFactory();new ActionFactoryReg().register(factory,game);
  const tanya=game.getPlayerByName('Germans').getOwnedObjects().find(u=>u.name==='TANY');
  const tick=n=>{for(let i=0;i<n&&!game.campaign.outcome;i++)game.update();};
  const order=(units,type,target,tile)=>{
   const select=factory.create(ActionType.SelectUnits);select.player=game.localPlayer;select.unitIds=units.map(u=>u.id);select.process();
   const action=factory.create(ActionType.OrderUnits);action.player=game.localPlayer;action.orderType=type;action.target=game.createTarget(target,tile??target?.tile);action.process();
  };
  window.__m2Order=order;window.__m2Tick=tick;
  if(!tanya)throw new Error('Missing Tanya');
  const start={x:tanya.tile.rx,y:tanya.tile.ry};
  const dest=game.map.tiles.getByMapCoords(tanya.tile.rx-3,tanya.tile.ry);
  order([tanya],OrderType.Move,undefined,dest);tick(400);
  if(tanya.tile.rx===start.x&&tanya.tile.ry===start.y)throw new Error('Cross-house Tanya move was rejected');
  const guns=game.getAllPlayers().flatMap(p=>p.getOwnedObjects()).filter(u=>u.name==='NAFLAK'&&u.owner.name==='Nod');
  if(guns.length!==2)throw new Error('Expected two first-base flak cannons');
  // Controlled combat fixture: remove the first base defenses through destruction
  // events, then test the mission's normal engineer/capture sequence independently.
  for (const gun of guns) game.destroyObject(gun,{player:game.localPlayer});
  for (const u of [...game.getPlayerByName('Confederation').getOwnedObjects()]) {
    if (u.name==='E2'||u.name==='NALASR') game.destroyObject(u,{player:game.localPlayer});
  }
  tick(5000);
  const human=game.localPlayer;
  const chapel=human.getOwnedObjects().find(u=>u.name==='CACOLO01');
  if(!chapel||!human.getOwnedObjects().some(u=>u.name==='GACNST'))throw new Error('Scripted engineers did not recover the chapel and construction yard');
  if(!game.campaign.firedTriggers.has('084B52DC'))throw new Error('Objective one not completed');
  const soviet=game.getPlayerByName('Russians');
  if(![...soviet.buildings].some(b=>b.name==='NAWEAP'))throw new Error('Soviet base nodes were not built');
  // Capture remaining occupied base structures through ordinary engineer orders.
  for(const name of ['GAPILE','GAREFN','GAWEAP']) {
    const building=game.getPlayerByName('Neutral2').getOwnedObjects().find(u=>u.name===name);
    const engineer=human.getOwnedObjects().filter(u=>u.name==='ENGINEER').sort((a,b)=>Math.hypot(a.tile.rx-building.tile.rx,a.tile.ry-building.tile.ry)-Math.hypot(b.tile.rx-building.tile.rx,b.tile.ry-building.tile.ry))[0];
    order([engineer],OrderType.Capture,building);tick(1100);
    if(building.owner!==human)throw new Error(`Could not capture ${name}`);
  }
  // Normal production must start the Soviet counterattack triggers.
  const {ObjectType}=await import('/src/engine/type/ObjectType.ts');
  const gi=game.rules.getObject('E1',ObjectType.Infantry);
  human.production.getQueueForObject(gi).push(gi,1,gi.cost);tick(1600);
  if(!game.campaign.aiTriggerHouses.has(soviet.country.id))throw new Error('Soviet AI was not activated by player production');
  const aiTeams=game.campaign.teams.active.map(t=>t.id);
  // Controlled destruction fixture validates the final trigger chain, not combat balance.
  for(let pass=0;pass<4;pass++) {
    for(const owner of [soviet,game.getPlayerByName('Confederation')])
      for(const unit of [...owner.getOwnedObjects(true)]) if(!unit.rules.insignificant)game.destroyObject(unit,{player:human});
    tick(1); // Destruction can spawn crew, which must also be defeated.
  }
  tick(240);
  if(game.campaign.outcome!=='victory')throw new Error('Mission two victory did not fire '+JSON.stringify({outcome:game.campaign.outcome,fired:[...game.campaign.firedTriggers],remaining:[soviet,game.getPlayerByName('Confederation')].flatMap(p=>p.getOwnedObjects(true).filter(u=>!u.rules.insignificant).map(u=>({name:u.name,hp:u.healthTrait.health,spawned:u.isSpawned})))}));
  const victoryTick=game.currentTick;
  // Isolated transport fixture exercises the retail capture-team load/wait/unload instructions.
  const transportGame=window.__createCampaignGame();transportGame.start();transportGame.update();
  const team=transportGame.campaign.teams.create(transportGame,'09820A7C',true,29);
  const transport=team.members.find(u=>u.transportTrait);
  for(let i=0;i<1200&&transport.transportTrait.units.length<5;i++)transportGame.update();
  if(transport.transportTrait.units.length!==5)throw new Error('Capture team did not load all five passengers');
  const loadedAt=transportGame.currentTick;
  transport.unitOrderTrait.clearOrders();transport.unitOrderTrait.cancelAllTasks();
  team.lines=[[8,0]];team.line=0;team.started=false;
  for(let i=0;i<1000&&transport.transportTrait.units.length;i++)transportGame.update();
  if(transport.transportTrait.units.length)throw new Error('Capture team did not unload');
  const transportCheck={loadedAt,unloadedAt:transportGame.currentTick,passengers:5};
  transportGame.dispose();
  const losses=[];
  for(const target of ['TANY','CACOLO01']) {
    const fresh=window.__createCampaignGame();fresh.start();fresh.update();
    const object=fresh.getAllPlayers().flatMap(p=>p.getOwnedObjects()).find(u=>u.name===target);
    fresh.destroyObject(object,{player:fresh.localPlayer});
    for(let i=0;i<5&&!fresh.campaign.outcome;i++)fresh.update();
    if(fresh.campaign.outcome!=='defeat')throw new Error(`${target} destruction did not fail mission`);
    losses.push({target,tick:fresh.currentTick});fresh.dispose();
  }
  return {victoryTick,losses,transportCheck,aiTeams,baseQueues:game.getPlayerByName('Russians').production.getAllQueues().map(q=>({status:q.status,items:q.getAll().map(i=>({name:i.rules.name,progress:i.progress}))})),guns:guns.length,tick:game.currentTick,outcome:game.campaign.outcome,fired:[...game.campaign.firedTriggers],objects:game.getAllPlayers().flatMap(p=>p.getOwnedObjects().map(u=>({id:u.id,name:u.name,owner:p.name,x:u.tile.rx,y:u.tile.ry}))),teams:game.campaign.teams.active.map(t=>({id:t.id,line:t.line,members:t.members.map(u=>u.name)}))};
 });
 result.runtime=runtime; result.regressions=regressions;
 console.log(JSON.stringify(result,null,2));
 writeFileSync(join(root,'build/mission-two-init-result.json'),JSON.stringify(result,null,2));
 if(errors) throw new Error(`${errors} page errors`);
} finally { await browser.close(); }
