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
 await page.route('**/config.ini*', route => route.fulfill({body:readFileSync(join(root, 'redalert2/public/config.ini'),'utf8').replace('engine = yr','engine = ra2').replace('generalmd.csf','general.csf'), contentType:'text/plain'}));
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
  const game=GameFactory.create(map,sets,Engine.getRules(),Engine.getArt(),Engine.getAi(),new IniFile(),[],'campaign-test',1,opts,modes,true,{},undefined,new BoxedVar(false),new BoxedVar(0),undefined,scenario);
  game.init(game.getPlayerByName('Player House'));
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
  let gated = false;
  try { game.start(); } catch (error) { gated = error.message.includes('Campaign runtime is still under development'); }
  if (!gated) throw new Error('Incomplete campaign execution was not gated');
  return {countries:game.getAllPlayers().map(p=>({name:p.name,country:p.country.name,id:p.country.id,credits:p.credits,objects:p.getOwnedObjects().length})),camera:game.campaign.initialCameraPosition(), expected:map.structures.length+map.vehicles.length+map.infantries.length+map.aircrafts.length};
 },text);
 console.log(JSON.stringify(result,null,2));
 writeFileSync(join(root, 'campaign-export/ra2/allied-01/init-result.json'),JSON.stringify(result,null,2));
} finally { await browser.close(); }
