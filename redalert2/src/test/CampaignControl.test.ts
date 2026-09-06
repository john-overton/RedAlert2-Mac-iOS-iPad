import {expect,test} from 'bun:test';
import {canControl,controllableObjects} from '../game/campaign/CampaignControl';
import {UnitSelectionLite} from '../game/gameobject/selection/UnitSelectionLite';
import {campaignMissionForMap,campaignMissions,campaignAssetPath} from '../data/campaign/CampaignMissions';

test('orders and mixed selections recognize controlled houses without transferring ownership',()=>{
    const human:any={getOwnedObjects:()=>[gi]},tanyaHouse:any={getOwnedObjects:()=>[tanya]},enemy:any={};
    const gi:any={owner:human,rules:{selectable:true}},tanya:any={owner:tanyaHouse,rules:{selectable:true}};
    human.campaignControlHouses=new Set([human,tanyaHouse]);
    expect(canControl(human,tanya)).toBe(true);
    expect(canControl(human,{owner:enemy})).toBe(false);
    expect(controllableObjects(human)).toEqual([gi,tanya]);
    const selection=new UnitSelectionLite(human);
    selection.update([gi,tanya]);
    expect(selection.getSelectedUnits()).toEqual([gi,tanya]);
    expect(tanya.owner).toBe(tanyaHouse);
    delete human.campaignControlHouses;
    expect(canControl(human,tanya)).toBe(false);
});

test('campaign map identity resolves the correct media and explicit next mission',()=>{
    const one=campaignMissionForMap('ALL01T.MAP')!;
    const two=campaignMissions.find(m=>m.id===one.next)!;
    expect(two.map).toBe('all02s.map');
    expect(campaignAssetPath(two,'brief.mp4')).toBe('campaign/ra2/allied-02/brief.mp4');
    expect(two.next).toBeUndefined();
    expect(campaignMissionForMap('../../all02s.map')).toBeUndefined();
});
