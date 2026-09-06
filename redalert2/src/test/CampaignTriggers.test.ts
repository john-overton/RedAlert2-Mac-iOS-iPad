import {expect,test} from 'bun:test';
import {IniFile} from '../data/IniFile';
import {CellTagsReader} from '../data/map/tag/CellTagsReader';
import {TriggerReader} from '../data/map/trigger/TriggerReader';
import {DestroyedAllBuildingsCondition} from '../game/trigger/condition/DestroyedAllBuildingsCondition';
import {BuildObjectTypeCondition} from '../game/trigger/condition/BuildObjectTypeCondition';
import {EventType} from '../game/event/EventType';
import {PlayerObservationCondition} from '../game/trigger/condition/PlayerObservationCondition';
import {MissileSpawnTrait} from '../game/gameobject/trait/MissileSpawnTrait';
import {NotifyDestroy} from '../game/gameobject/trait/interface/NotifyDestroy';

test('cell tags preserve hexadecimal identifiers and leading zeros',()=>{
    const ini=new IniFile({CellTags:{'28065':'0965B06C','29064':'00000001'}});
    expect(new CellTagsReader().read(ini.getSection('CellTags')!,4)).toEqual([
        {tagId:'0965B06C',coords:{x:65,y:28}}, {tagId:'00000001',coords:{x:64,y:29}}
    ]);
});
test('numeric durations remain numeric while alphabetic waypoints decode',()=>{
    const ini=new IniFile({Triggers:{T:'Player,<none>,Test,0,1,1,1,0'},Events:{T:'1,13,0,0'},
        Actions:{T:'2,104,5,TEAM,0,0,0,0,120,48,0,3,0,0,0,0,AB'}});
    const result=new TriggerReader().read(ini.getSection('Triggers')!,ini.getSection('Events')!,ini.getSection('Actions')!,[{id:'TAG',triggerId:'T',repeatType:0}]);
    expect(result.triggers[0].actions.map(a=>a.params[6])).toEqual([120,27]);
});
test('campaign destruction checks include completed objectives and ignore scenery',()=>{
    const owned:any[]=[{isBuilding:()=>true,rules:{insignificant:false},isDestroyed:false}];
    const player={country:{id:14},getOwnedObjects:()=>owned};
    const condition=new DestroyedAllBuildingsCondition({params:[0,'14']},{});
    const game={campaign:{},getAllPlayers:()=>[player]};
    expect(condition.check(game,[])).toBe(false);
    owned[0].isDestroyed=true;
    owned.push({isBuilding:()=>true,rules:{insignificant:true}});
    expect(condition.check(game,[])).toBe(true);
});
test('build events must match both house and object type',()=>{
    const player={country:{name:'Player'}};
    const condition=new BuildObjectTypeCondition({params:[0,'7']},{houseName:'Player'},2);
    condition.init({getAllPlayers:()=>[player]});
    const event={type:EventType.ObjectSpawn,gameObject:{owner:{},type:2,rules:{index:7}}};
    expect(condition.check({},[event])).toBe(false);
    event.gameObject.owner=player;
    expect(condition.check({},[event])).toBe(true);
});
test('discovery and selection conditions require the observed attached object',()=>{
    const tile={};const obj={isSpawned:true,isDestroyed:false,tile,tileElevation:0};
    let shrouded=true,selected=false;
    const game={campaign:{selectedUnitIds:{has:()=>selected}},localPlayer:{},mapShroudTrait:{getPlayerShroud:()=>({isShrouded:()=>shrouded})},
        map:{tileOccupation:{calculateTilesForGameObject:()=>[tile]}},unitSelection:{isSelected:()=>selected}};
    for(const type of [4,33]){
        const c=new PlayerObservationCondition({type},{});c.setTargets([obj]);
        expect(c.check(game)).toEqual([]);
        if(type===4)shrouded=false;else selected=true;
        expect(c.check(game)).toEqual([obj]);
    }
});
test('intercepted missiles do not detonate their impact warhead',()=>{
    let detonations=0;
    const trait=new MissileSpawnTrait().setDamage(400).setWarhead({detonate:()=>detonations++}).setLauncher({} as any);
    trait[NotifyDestroy.onDestroy]({} as any,{} as any);
    expect(detonations).toBe(0);
});

test('destroyed-count events count their own house and the requested object category', async()=>{
    const {DestroyedBuildingsCondition}=await import('../game/trigger/condition/DestroyedBuildingsCondition');
    const {DestroyedUnitsCondition}=await import('../game/trigger/condition/DestroyedUnitsCondition');
    const player={country:{name:'Target'}},other={country:{name:'Other'}};
    for(const [Condition,building] of [[DestroyedBuildingsCondition,true],[DestroyedUnitsCondition,false]] as const) {
        const condition=new Condition({params:['0','2']},{houseName:'Target'});
        condition.init({getAllPlayers:()=>[player,other]});
        const event=(owner:any,isBuilding:boolean)=>({type:EventType.ObjectDestroy,target:{owner,isBuilding:()=>isBuilding,isUnit:()=>!isBuilding}});
        expect(condition.check({},[event(other,building),event(player,!building)])).toBe(false);
        expect(condition.check({},[event(player,building)])).toBe(false);
        expect(condition.check({},[event(player,building)])).toBe(true);
    }
});
