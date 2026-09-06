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

 const results=await page.evaluate(async()=>{
  const d=window.__ra2debug,g=d.game,screen=d.gameScreen;
  const {ObjectType}=await import('/src/engine/type/ObjectType.ts');
  const {ActionFilter}=await import('/src/gui/screen/game/worldInteraction/ActionFilter.ts');
  const {PointerType}=await import('/src/engine/type/PointerType.ts');
  const {RadialTileFinder}=await import('/src/game/map/tileFinder/RadialTileFinder.ts');
  const building=g.getAllPlayers().flatMap(p=>p.getOwnedObjects()).find(b=>b.isBuilding()&&b.garrisonTrait?.canBeOccupied()&&g.campaign.isCivilianHouse(b.owner));
  if(!building)throw new Error('No campaign civilian garrisonable');
  const originalOwner=building.owner;
  const spawn=name=>{
   const unit=g.createUnitForPlayer(g.rules.getObject(name,ObjectType.Infantry),g.localPlayer);
   const tile=new RadialTileFinder(g.map.tiles,g.map.mapBounds,building.tile,building.getFoundation(),1,4,t=>g.map.terrain.getPassableSpeed(t,unit.rules.speedType,true,false)>0&&!g.map.getGroundObjectsOnTile(t).some(o=>o.isTechno())).getNextTile();
   g.spawnObject(unit,tile);return unit;
  };
  const handler=d.worldInteraction.defaultActionHandler;
  const hover=b=>({gameObject:b,tile:b.tile,entity:d.renderableManager.getRenderableByGameObject(b)});
  const inspect=(unit,target)=>{
   d.worldInteraction.unitSelectionHandler.selectSingleUnit(unit);
   handler.update(hover(target),[unit],true,{},false);
   return {icon:PointerType[handler.getPointerType(false)],order:handler.mostSignificantAction?.constructor.name};
  };
  const gi=spawn('E1');
  const occupy=inspect(gi,building);
  handler.execute(hover(building),[gi],ActionFilter.NoSelect,false,false,{});
  for(let i=0;i<900&&!building.garrisonTrait.units.includes(gi);i++)screen.gameTurnMgr.doGameTurn(performance.now());
  if(!building.garrisonTrait.units.includes(gi))throw new Error('GI did not enter '+JSON.stringify(occupy));
  if(building.owner!==g.localPlayer)throw new Error('Garrison did not become controllable');
  const evacuate=inspect(building,building);
  const engineer=spawn('ENGINEER');
  building.healthTrait.health=50;
  const repair=inspect(engineer,building);
  const hut=g.getAllPlayers().flatMap(p=>p.getOwnedObjects()).find(b=>b.name==='CABHUT'&&b.cabHutTrait.canRepairBridge());
  const bridge=inspect(engineer,hut);
  const tanya=g.localPlayer.getOwnedObjects().find(u=>u.name==='TANY');
  const enemy=[...g.getPlayerByName('BadGuy1 House').buildings].find(b=>b.c4ChargeTrait);
  const c4=inspect(tanya,enemy);
  if(occupy.icon!=='Occupy'||evacuate.icon!=='Deploy'||repair.icon!=='RepairMove'||bridge.icon!=='RepairMove'||c4.icon!=='C4')throw new Error(JSON.stringify({occupy,evacuate,repair,bridge,c4}));
  window.__interactionSetup={gi,building,originalOwner};
  return {occupy,evacuate,repair,bridge,c4,unloaded:true};
 });
 await page.mouse.move(400,400);
 const cursor=await page.evaluate(()=>{const p=window.__ra2debug.gameScreen.pointer;return {locked:p.getPointerLock().isActive(),visible:p.getSprite().getHtmlContainer().getElement().style.display,cursor:window.__ra2debug.renderer.getCanvas().style.cursor};});
 if(cursor.locked||cursor.visible==='none'||cursor.cursor!=='none')throw new Error('Unlocked game cursor missing '+JSON.stringify(cursor));
 const target=await page.evaluate(async()=>{
  const d=window.__ra2debug,g=d.game,{gi,building}=window.__interactionSetup;
  building.healthTrait.health=100;
  const {ActionFilter}=await import('/src/gui/screen/game/worldInteraction/ActionFilter.ts');
  const {MapPanningHelper}=await import('/src/engine/util/MapPanningHelper.ts');
  d.worldInteraction.rightClickMove.value=true;
  d.worldInteraction.unitSelectionHandler.deselectAll();
  d.worldScene.cameraPan.setPan(new MapPanningHelper(g.map).computeCameraPanFromTile(building.tile.rx,building.tile.ry));
  d.renderer.update(performance.now(),0);d.renderer.render();
  d.gameScreen.gameAnimationLoop.start();
  return d.helpers.getOwnedBuildingClickTargetsById(building.id);
 });
 let selected=false;
 for(const point of target.candidates){
  await page.mouse.click(point.x,point.y-5);
  selected=await page.evaluate(id=>window.__ra2debug.helpers.getSelectedUnitIds().includes(id),target.buildingId);
  if(selected){
   await page.mouse.move(point.x+1,point.y-5);
   await page.waitForFunction(()=>window.__ra2debug.gameScreen.pointer.pointerType===110,undefined,{timeout:5000});
   await page.screenshot({path:'build/campaign-garrison-cursor.png'});
   await page.mouse.click(point.x+1,point.y-5,{button:'right'});
   break;
  }
 }
 if(!selected)throw new Error('Mouse could not select garrison');
 await page.waitForFunction(()=>!window.__interactionSetup.building.garrisonTrait.units.length,undefined,{timeout:10000});
 await page.evaluate(()=>{const {gi,building,originalOwner}=window.__interactionSetup;if(!gi.isSpawned||building.owner!==originalOwner)throw new Error('Unload failed to restore infantry and civilian ownership');});
 results.mouseUnload=true;
 writeFileSync('build/campaign-interaction-result.json',JSON.stringify({results,cursor,errors},null,2));
 if(errors.length)throw new Error('Interaction errors');
 console.log('Interaction checks passed',JSON.stringify(results));
} finally {await browser.close();}
