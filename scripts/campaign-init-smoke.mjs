import { campaignTestConfig } from './campaign-test-config.mjs';
// Requires the local Vite dev server and imported mission-one assets.
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
 const text = readFileSync(join(root, 'campaign-export/ra2/allied-01/all01t.map'),'utf8');
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
  const opts = {gameMode:modes.getAll()[0].id,gameSpeed:5,credits:100,unitCount:0,shortGame:false,superWeapons:true,buildOffAlly:false,mcvRepacks:false,cratesAppear:false,destroyableBridges:true,multiEngineer:false,noDogEngiKills:false,mapName:'all01t.map',mapTitle:'Mission 1',mapDigest:'',mapSizeBytes:text.length,maxSlots:8,mapOfficial:true,humanPlayers:[{name:'Player House',countryId:0,colorId:0,startPos:0,teamId:0}],aiPlayers:[]};
  window.__createCampaignGame=()=>{
    const game=GameFactory.create(map,sets,Engine.getRules(),Engine.getArt(),Engine.getAi(),new IniFile(),[],'campaign-test',1,opts,modes,true,{},undefined,new BoxedVar(false),new BoxedVar(0),undefined,scenario);
  game.init(game.getPlayerByName('Player House'));
    return game;
  };
  const game=window.__createCampaignGame();
  const expectedObjects = [...map.structures, ...map.vehicles, ...map.infantries, ...map.aircrafts];
  for (const house of scenario.houses) {
    const player = game.getPlayerByName(house.id);
    const expected = expectedObjects.filter(object => object.owner === house.id);
    if (player.getOwnedObjects().length !== expected.length) throw new Error(`Wrong object count for ${house.id}`);
    if (player.credits !== Number(house.properties.Credits) * 100) throw new Error(`Wrong credits for ${house.id}`);
    for (const other of scenario.houses) {
      if (other.id === house.id) continue;
      const allied = (house.properties.Allies ?? '').split(',').includes(other.id);
      if (game.alliances.areAllied(player, game.getPlayerByName(other.id)) !== allied) throw new Error(`Wrong alliance ${house.id} -> ${other.id}`);
    }
  }
  const human = game.getPlayerByName(scenario.playerHouse.id);
  if (!human.getOwnedObjects().some(object => object.name === 'TANY')) throw new Error('Tanya did not spawn');
  if (human.radarTrait.isDisabled()) throw new Error('Free radar not active');
  Error.stackTraceLimit=30;
  const deaths=[];
  const {EventType}=await import('/src/game/event/EventType.ts');
  game.events.subscribe(e=>{if(e.type===EventType.ObjectDestroy && e.target.isTechno()) deaths.push({tick:game.currentTick,name:e.target.name,owner:e.target.owner?.name,attacker:e.attackerInfo?.player?.name,incidental:e.incidental});});
  game.start();
  window.__campaignTestGame = game;
  for (let i=0;i<850;i++) game.update();
  return {deaths, outcome:game.campaign.outcome, locked:game.campaign.inputLocked,tick:game.currentTick, teams:game.campaign.teams.active.map(t=>({id:t.id,line:t.line,members:t.members.map(u=>u.name)})), fired:[...game.campaign.firedTriggers], countries:game.getAllPlayers().map(p=>({name:p.name,country:p.country.name,id:p.country.id,credits:p.credits,objects:p.getOwnedObjects().length})),camera:game.campaign.initialCameraPosition(), expected:map.structures.length+map.vehicles.length+map.infantries.length+map.aircrafts.length};
 },text);
 if (process.argv.includes('--runtime')) {
  const runtime = await page.evaluate(async()=>{
    const game=window.__campaignTestGame;
    const {OrderFactory}=await import('/src/game/order/OrderFactory.ts');
    const {OrderType}=await import('/src/game/order/OrderType.ts');
    const human=game.getPlayerByName('Player House');
    const tanya=human.getOwnedObjects().find(u=>u.name==='TANY');
    const orders=new OrderFactory(game,game.map);
    const tick=(n)=>{for(let i=0;i<n&&!game.campaign.outcome;i++)game.update();};
    const order=(type,obj,tile)=>tanya.unitOrderTrait.addOrder(orders.create(type,game.unitSelection).set(tanya,game.createTarget(obj,tile)));
    const ships=game.getPlayerByName('BadGuy2 House').getOwnedObjects().filter(u=>u.name==='DRED');
    if (ships.length!==4) throw new Error('Opening destroyed the mission targets before player input');
    for(const ship of ships){
      order(OrderType.Attack,ship,ship.tile);
      for(let i=0;i<1800&&!ship.isDestroyed&&!tanya.isDestroyed;i++)tick(1);
      if (!ship.isDestroyed) throw new Error('Tanya could not destroy Dreadnought');
    }
    for(let i=0;i<180&&!game.campaign.firedTriggers.has('07B92F3C');i++)tick(1);
    if(!game.campaign.firedTriggers.has('07B92F3C')) throw new Error('Objective 1 did not fire');
    order(OrderType.Move,undefined,game.map.getTileAtWaypoint(16));
    tick(2500);
    if (!human.getOwnedObjects().some(u=>u.name==='GACNST')) throw new Error('Fort Bradley did not transfer to the player');
    const {UpdateQueueAction,UpdateType}=await import('/src/game/action/UpdateQueueAction.ts');
    const {PlaceBuildingAction}=await import('/src/game/action/PlaceBuildingAction.ts');
    const {ObjectType}=await import('/src/engine/type/ObjectType.ts');
    const enqueue=(name,type,quantity=1)=>{
      const rules=game.rules.getObject(name,type);
      const action=Object.assign(new UpdateQueueAction(game),{player:human,item:rules,quantity,updateType:UpdateType.Add,queueType:human.production.getQueueTypeForObject(rules)});
      action.process();return rules;
    };
    const barracks=enqueue('GAPILE',ObjectType.Building);
    const queue=human.production.getQueueForObject(barracks);
    for(let i=0;i<1800&&queue.status!==3;i++)tick(1);
    if(queue.status!==3) throw new Error('Barracks did not finish production');
    let placed=false;
    for(let y=30;y<46&&!placed;y++)for(let x=66;x<79&&!placed;x++){
      const tile=game.map.tiles.getByMapCoords(x,y);
      if(tile&&game.getConstructionWorker(human).canPlaceAt('GAPILE',tile,{normalizedTile:true})){
        Object.assign(new PlaceBuildingAction(game),{player:human,buildingRules:barracks,tile:{x,y}}).process();placed=true;
      }
    }
    if(!placed) throw new Error('No legal barracks location in Fort Bradley');
    tick(100);
    enqueue('ENGINEER',ObjectType.Infantry);
    tick(900);
    const engineer=human.getOwnedObjects().find(u=>u.name==='ENGINEER');
    if(!engineer)throw new Error('Engineer did not leave the barracks');
    const hut=game.getAllPlayers().flatMap(p=>p.getOwnedObjects()).find(u=>u.name==='CABHUT'&&u.tile.rx===80);
    const repair=orders.create(OrderType.Repair).set(engineer,game.createTarget(hut,hut.tile));
    if(!repair.isValid()||!repair.isAllowed())throw new Error('Engineer cannot repair mission bridge '+JSON.stringify({valid:repair.isValid(),allowed:repair.isAllowed(),bridge:hut.cabHutTrait.closestBridge,engineer:engineer.name,allied:game.areFriendly(engineer,hut), bridgeStart:[hut.cabHutTrait.closestBridge?.start.rx,hut.cabHutTrait.closestBridge?.start.ry], damageWaypoints:[79,80].map(w=>{const t=game.map.getTileAtWaypoint(w);const b=game.map.tileOccupation.getBridgeOnTile(t);return {w,x:t.rx,y:t.ry,bridge:b?.name,hp:b?.healthTrait?.health,max:b?.healthTrait?.maxHitPoints}}),HE:game.rules.getWarhead('HE').wall},(k,v)=>['obj','tile','start','end'].includes(k)?undefined:v));
    engineer.unitOrderTrait.addOrder(repair);
    tick(1200);
    if(!game.campaign.productionHouses.has(game.getPlayerByName('BadGuy1 House').country.id))throw new Error('Bridge repair did not enable enemy production');
    order(OrderType.Move,undefined,game.map.getTileAtWaypoint(16));
    const enemy=game.getPlayerByName('BadGuy1 House');
    const reinforcements=[];
    const {EventType}=await import('/src/game/event/EventType.ts');
    game.events.subscribe(e=>{if(e.type===EventType.ObjectSpawn&&e.gameObject.owner===enemy&&e.gameObject.name==='E2')reinforcements.push(e.gameObject.id);});
    tick(1800);
    // This is a mission-logic regression, not an AI autoplay benchmark. Apply
    // controlled destruction through the engine, then require the retail
    // objective and delayed outcome triggers to complete without forcing them.
    for(const building of [...enemy.buildings]) if(!building.rules.insignificant)game.destroyObject(building,{player:human,obj:tanya});
    tick(180);
    if(game.campaign.outcome!=='victory')throw new Error('Final objective did not end in victory');
    const defeat=window.__createCampaignGame();
    defeat.start();
    const lostTanya=defeat.getPlayerByName('Player House').getOwnedObjects().find(u=>u.name==='TANY');
    defeat.destroyObject(lostTanya,{player:defeat.getPlayerByName('BadGuy1 House')});
    for(let i=0;i<180&&!defeat.campaign.outcome;i++)defeat.update();
    if(defeat.campaign.outcome!=='defeat'||!defeat.getPlayerByName('Player House').defeated)throw new Error('Tanya loss did not end in defeat');
    return {testMode:'Mission logic with controlled final destruction; not a full combat autoplay',reinforcements:reinforcements.length,defeat:defeat.campaign.outcome, tick:game.currentTick,tanya:{x:tanya.tile.rx,y:tanya.tile.ry,dead:tanya.isDestroyed},outcome:game.campaign.outcome,
      owned:human.getOwnedObjects().map(u=>u.name),fired:[...game.campaign.firedTriggers],production:[...game.campaign.productionHouses],ai:[...game.campaign.aiTriggerHouses]};
  });
  console.log('RUNTIME',JSON.stringify(runtime,null,2));
  writeFileSync(join(root,'build/campaign-runtime-result.json'),JSON.stringify(runtime,null,2));
 }
 console.log(JSON.stringify(result,null,2));
 writeFileSync(join(root, 'campaign-export/ra2/allied-01/init-result.json'),JSON.stringify(result,null,2));
} finally { await browser.close(); }
