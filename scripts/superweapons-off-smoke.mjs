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
  const g=window.__ra2debug.game;window.__ra2debug.gameScreen.gameAnimationLoop.stop();
  const {Production}=await import('/src/game/player/production/Production.ts');
  const {SuperWeaponTrait}=await import('/src/game/gameobject/trait/SuperWeaponTrait.ts');
  const {NotifySpawn}=await import('/src/game/gameobject/trait/interface/NotifySpawn.ts');
  const {NotifyOwnerChange}=await import('/src/game/gameobject/trait/interface/NotifyOwnerChange.ts');
  const assert=(condition,message)=>{if(!condition)throw new Error(message)};
  const results=[];
  for(const [country,base,lab,tank,weapons] of [
   ['Americans',['GACNST','GAPOWR','GAREFN','GAPILE','GAWEAP','GAAIRC'],'GATECH','SREF',['GACSPH','GAWEAT']],
   ['Russians',['NACNST','NAPOWR','NAREFN','NAHAND','NAWEAP','NARADR'],'NATECH','APOC',['NAIRON','NAMISL']],
   ['YuriCountry',['YACNST','YAPOWR','YAREFN','YABRCK','YAWEAP','NAPSIS'],'YATECH','MIND',['YAGNTC','YAPPET']],
  ]) {
   const buildings=new Set(base.map(name=>{const rules=g.rules.getObject(name,2);return {name,rules,factoryTrait:rules.factory?{type:rules.factory}:undefined}}));
   const player={country:{name:country},buildings,isAi:false};
   const opts={...g.gameOpts,superWeapons:false};
   const production=new Production(player,g.rules.mpDialogSettings.techLevel,opts,g.rules,[]);
   const labRules=g.rules.getObject(lab,2),tankRules=g.rules.getObject(tank,7);
   assert(production.isAvailableForProduction(labRules),`${lab} unavailable with superweapons off`);
   assert(!production.isAvailableForProduction(tankRules),`${tank} available before lab`);
   buildings.add({name:lab,rules:labRules});
   assert(production.isAvailableForProduction(tankRules),`${tank} unavailable after lab`);
   for(const name of weapons)assert(!production.isAvailableForProduction(g.rules.getObject(name,2)),`${name} available with superweapons off`);
   opts.superWeapons=true;
   for(const name of weapons)assert(production.isAvailableForProduction(g.rules.getObject(name,2)),`${name} unavailable with superweapons on`);
   results.push({lab,tank,disabledBuildings:weapons});
  }
  for(const [name,enabled,expected] of [['ForceShieldSpecial',false,false],['ForceShieldSpecial',true,true],['SpyPlaneSpecial',false,true],['NukeSpecial',false,false]]) {
   const owned=new Map(),player={superWeaponsTrait:{has:n=>owned.has(n),add:sw=>owned.set(name,sw)}};
   const world={gameOpts:{superWeapons:enabled},rules:g.rules,createSuperWeapon:n=>({rules:g.rules.getSuperWeapon(n)})};
   const trait=new SuperWeaponTrait(name);
   trait[NotifySpawn.onSpawn]({owner:player},world);
   assert(owned.has(name)===expected,`Wrong ability availability for ${name}, enabled=${enabled}`);
   owned.clear();trait[NotifyOwnerChange.onChange]({owner:player},{},world);
   assert(owned.has(name)===expected,`Wrong captured ability availability for ${name}`);
  }
  return results;
 });console.log('YR superweapons-off production and abilities passed:',JSON.stringify(result));
 await (await import('./gameplay-followup-checks.mjs')).checkGameplayFollowups(page);
}finally{await browser.close();}
