import {chromium} from '../redalert2/node_modules/playwright-core/index.mjs';
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
 const page=await browser.newPage();
 await page.goto(`${process.env.RA2_DEV_URL || 'http://127.0.0.1:4001'}/?shell=1`);
 await page.waitForFunction(()=>window.__ra2debug?.keyBinds,undefined,{timeout:300000});
 await page.getByText('Skirmish',{exact:true}).click();
 await page.waitForFunction(()=>window.__ra2debug?.skirmishLobby?.gameOpts);
 await page.evaluate(async()=>{
  const screen=window.__ra2debug.mainMenuController.getCurrentScreen();
  const {Engine}=await import('/src/engine/Engine.ts');
  const entry=screen.mapList.getAll().filter(m=>m.official&&m.maxSlots>=4&&Engine.vfs.fileExists(m.fileName)).sort((a,b)=>a.fileName.localeCompare(b.fileName))[0];
  const pc=screen.pregameController;pc.applyMapSelection({gameMode:screen.gameModes.getById(pc.getGameOpts().gameMode),mapName:entry.fileName,changedMapFile:await Engine.vfs.openFileWithRfs(entry.fileName)});
  const opts=pc.getGameOpts();opts.shortGame=false;opts.aiPlayers=Array.from({length:opts.maxSlots},(_,i)=>i===1?{difficulty:0,countryId:1,colorId:1,startPos:1,teamId:-2}:undefined);
  opts.humanPlayers[0]={...opts.humanPlayers[0],countryId:0,colorId:0,startPos:0,teamId:-2};
  screen.rootController.createGame('outpost-smoke',1,'',screen.playerName,opts,true,false,false,false,undefined);
 });
 await page.waitForFunction(()=>window.__ra2debug?.gameScreen?.gameTurnMgr,undefined,{timeout:180000});
 const result=await page.evaluate(async()=>{
  const game=window.__ra2debug.game;window.__ra2debug.gameScreen.gameAnimationLoop.stop();
  const {ZoneType}=await import('/src/game/gameobject/unit/ZoneType.ts');
  const players=game.playerList.getCombatants();const owner=game.localPlayer,enemy=players.find(p=>p!==owner);
  const outpost=game.world.getAllObjects().find(o=>o.name==='CAOUTP');
  if(!outpost) throw new Error('Fixture map has no outpost');
  const neutralPower=outpost.poweredTrait.isPoweredOn();
  const {CaptureBuildingTask}=await import('/src/game/gameobject/task/CaptureBuildingTask.ts');
  const engineer=game.createObject(3,'ENGINEER');game.changeObjectOwner(engineer,owner);game.spawnObject(engineer,game.map.tiles.getByMapCoords(outpost.tile.rx+4,outpost.tile.ry+1));
  engineer.unitOrderTrait.addTask(new CaptureBuildingTask(game,outpost));
  for(let tick=0;tick<900&&outpost.owner!==owner;tick++)game.update();
  if(outpost.owner!==owner)throw new Error('Engineer did not capture outpost');
  const base={rx:outpost.tile.rx-5,ry:outpost.tile.ry-5};
  const target=game.createObject(7,'ZEP');game.changeObjectOwner(target,enemy);game.spawnObject(target,game.map.tiles.getByMapCoords(base.rx+10,base.ry+6));target.zone=ZoneType.Air;target.position.tileElevation=5;target.moveTrait.setDisabled(true);target.attackTrait?.setDisabled(true);
  for(let i=0;i<100;i++)game.update();
  const before=target.healthTrait.getHitPoints();const samples=[];let missiles=0;
  for(let i=0;i<300;i++){game.update();missiles+=game.world.getAllObjects().filter(o=>o.isProjectile()&&o.fromObject===outpost).length;if(i%30===0)samples.push({tick:i,hp:target.healthTrait.getHitPoints(),projectiles:game.world.getAllObjects().filter(o=>o.isProjectile()).map(o=>o.name),state:outpost.attackTrait.attackState,disabled:outpost.attackTrait.isDisabled(),passive:outpost.attackTrait.shouldPassiveAcquire(outpost),weapon:outpost.primaryWeapon?.rules.name,task:outpost.unitOrderTrait.getCurrentTask()?.constructor.name,angle:outpost.turretTrait.facing,desired:outpost.turretTrait.desiredFacing,zone:target.zone,altitude:target.tileElevation});}
  const renderable=window.__ra2debug.renderableManager.getRenderableByGameObject(outpost);
  game.unitSelection.addToSelection(outpost);
  renderable.update(performance.now());
  const rangeVisible=renderable.rangeCircleWrapper?.visible;
  if(!rangeVisible)throw new Error('Captured outpost range ring is not visible when selected');
  game.unitSelection.removeFromSelection([outpost]);
  renderable.update(performance.now()+16);
  if(renderable.rangeCircleWrapper?.visible)throw new Error('Outpost range ring stays visible after deselection');
  return {rangeVisible,range:outpost.primaryWeapon.range,missiles,map:game.gameOpts.mapName,neutralPower,turnedOn:outpost.poweredTrait.turnedOn,powered:outpost.poweredTrait.isPoweredOn(),before,after:target.healthTrait.getHitPoints(),samples};
 });console.log(JSON.stringify({map:result.map,rangeRingVisible:result.rangeVisible,weaponRange:result.range,missileObservations:result.missiles,aircraftHPBefore:result.before,aircraftHPAfter:result.after,capturedByEngineer:true}));
 if(!result.missiles||result.after>=result.before)throw new Error('Captured tech outpost did not damage enemy aircraft');
}finally{await browser.close();}
