import {expect, test} from 'bun:test';
import {WeaponTargeting} from '../game/WeaponTargeting';
import {WeaponType} from '../game/WeaponType';
import {LandTargeting} from '../game/type/LandTargeting';
import {NavalTargeting} from '../game/type/NavalTargeting';

// Synthetic one-way relationships match the two failures in Eagle Dawn.
const unit = (owner: string) => ({name:'ROCK', owner, rules:{landTargeting:LandTargeting.LandOk, navalTargeting:NavalTargeting.NavalAll},
    isUnit:()=>false, isBuilding:()=>true, isTechno:()=>true, isInfantry:()=>false, isVehicle:()=>false, isAircraft:()=>false});
const shooter = unit('Alliance');
const targeting = new WeaponTargeting(WeaponType.Primary, {isAntiGround:true, isAntiAir:true}, {damage:20}, {}, shooter, {prism:{type:'GT'}});
const game = {areFriendly:(source:any,target:any)=>source.owner===target.owner ||
    (source.owner==='Alliance' && target.owner==='French') || (source.owner==='Confederation' && target.owner==='Alliance'),
    alliances:{haveSharedIntel:()=>false}};
test('rocketeers protect engineers even when the engineer house does not reciprocate its alliance',()=>{
    expect(targeting.canTarget(unit('French'), undefined, game)).toBe(false);
});
test('rocketeers can attack sentries even when the sentry house considers them friendly',()=>{
    expect(targeting.canTarget(unit('Confederation'), undefined, game)).toBe(true);
});
test('explicit force fire remains available against friendlies',()=>{
    expect(targeting.canTarget(unit('French'), undefined, game, true)).toBe(true);
});
