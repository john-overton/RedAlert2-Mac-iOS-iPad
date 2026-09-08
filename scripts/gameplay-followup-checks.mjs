// Runs inside the asset-backed browser used by superweapons-off-smoke.
export async function checkGameplayFollowups(page) {
 await page.evaluate(async () => {
  const game = window.__ra2debug.game;
  const {CaptureOrder} = await import('/src/game/order/CaptureOrder.ts');
  const {CaptureBuildingTask, shouldDamageBeforeCapture} = await import('/src/game/gameobject/task/CaptureBuildingTask.ts');
  const {BuildStatus} = await import('/src/game/gameobject/Building.ts');
  const {PointerType} = await import('/src/engine/type/PointerType.ts');
  const {Warhead} = await import('/src/game/Warhead.ts');
  const {Debris} = await import('/src/game/gameobject/Debris.ts');
  const {PsychicDominatorEffect} = await import('/src/game/superweapon/PsychicDominatorEffect.ts');
  const {SuperWeaponType} = await import('/src/game/type/SuperWeaponType.ts');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const owner = game.localPlayer, enemy = game.playerList.getCombatants().find(p => p !== owner);
  const engineer = { isInfantry: () => true, rules: { engineer: true }, owner };
  const target = { isBuilding: () => true, rules: {capturable: true, needsEngineer: false}, owner: enemy,
   buildStatus: BuildStatus.Ready, healthTrait: {health: 100}, isDestroyed: false };
  const context = { gameOpts: {multiEngineer: false}, rules: game.rules, areFriendly: (a,b) => a.owner === b.owner };
  const order = new CaptureOrder(context).set(engineer, {obj: target});
  const task = new CaptureBuildingTask(context, target);
  assert(order.isAllowed() && task.isAllowed(engineer), 'Enemy capture rejected');
  assert(order.getPointerType(false) === PointerType.Occupy, 'Single engineer should capture at full health');
  context.gameOpts.multiEngineer = true;
  assert(order.getPointerType(false) === PointerType.EngineerDamage && shouldDamageBeforeCapture(context,target), 'High-health multi-engineer damage missing');
  target.healthTrait.health = 100 * game.rules.general.engineerCaptureLevel;
  assert(order.getPointerType(false) === PointerType.Occupy, 'Capture threshold mismatch');
  target.healthTrait.health = 100; target.rules.needsEngineer = true;
  if (game.rules.general.engineerAlwaysCaptureTech) assert(order.getPointerType(false) === PointerType.Occupy, 'Enemy-held tech building shows incorrect damage cursor');
  for (const [key,value] of [['owner',owner],['buildStatus',BuildStatus.BuildDown],['isDestroyed',true]]) {
   const previous=target[key];target[key]=value;
   assert(!order.isAllowed() && !task.isAllowed(engineer), `Capture cursor/task disagree on ${key}`);target[key]=previous;
  }
  target.rules.capturable=false;
  assert(!order.isAllowed() && !task.isAllowed(engineer), 'Uncapturable building accepted');

  // Pick actual batched building sprites using their projected graphic centers.
  const {RaycastHelper} = await import('/src/engine/util/RaycastHelper.ts');
  const scene=window.__ra2debug.worldScene;
  scene.scene.updateMatrixWorld(true);
  const raycast=new RaycastHelper(scene);
  let picked=0;
  for(const object of game.world.getAllObjects().filter(o=>o.isBuilding())) {
   const renderable=window.__ra2debug.renderableManager.getRenderableByGameObject(object);
   const targets=renderable?.getIntersectTarget?.();
   for(const mesh of (Array.isArray(targets)?targets:[targets]).filter(m=>m?.isBatchedMesh)) {
    mesh.geometry.computeBoundingBox();
    const point=mesh.geometry.boundingBox.getCenter(mesh.position.clone()).applyMatrix4(mesh.matrixWorld).project(scene.camera);
    const screen={x:scene.viewport.x+(point.x+1)*scene.viewport.width/2,y:scene.viewport.y+(1-point.y)*scene.viewport.height/2};
    assert(raycast.intersect(screen,[mesh]).length>0, `Cannot pick visible graphic for ${object.name}`);
    picked++;break;
   }
   if(picked>=5)break;
  }
  assert(picked>=1,'Fixture contains no batched building graphics to test');
  // Exercise actual debris and Dominator callers; only weather storms may set flag 12.
  const calls=[], original=Warhead.prototype.detonate;
  const tile=game.localPlayer.startLocation || game.map.tiles.getAll()[0];
  const actualTile=tile.rx === undefined ? game.map.tiles.getAll()[0] : tile;
  try {
   Warhead.prototype.detonate=function(...args){calls.push(args);};
   const debris={rules:{warhead:'HE',damage:10},tile:actualTile,tileElevation:0,
    position:{worldPosition:game.localPlayer.getOwnedObjectsByType(2)[0]?.position.worldPosition || {x:0,y:0,z:0}},
    collisionHelper:{computeDetonationZone:()=>0}};
   Debris.prototype.detonate.call(debris,{rules:game.rules,createTarget:game.createTarget.bind(game),destroyObject:()=>{}});
   new PsychicDominatorEffect(SuperWeaponType.PsychicDominator, owner, actualTile).detonate(game);
   assert(calls.length === 2 && calls.every(args => !args[12]), 'Non-storm destruction requests lightning');
  } finally { Warhead.prototype.detonate=original; }
 });
 console.log('Engineer capture eligibility/cursors and debris/Dominator lightning regressions passed');
}
