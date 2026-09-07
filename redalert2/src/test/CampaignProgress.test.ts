import {expect, test} from 'bun:test';
import {campaignMissions} from '../data/campaign/CampaignMissions';
import {campaignProgressKey, readCampaignProgress, recordCampaignProgress, campaignCompletion} from '../data/campaign/CampaignProgress';
function storage(initial = '{"started":false,"completed":[]}') {
    const values = new Map([[campaignProgressKey, initial]]);
    return {getItem:(key:string)=>values.get(key) ?? null, setItem:(key:string,value:string)=>{values.set(key,value);}};
}
test('new campaign starts empty; starting and restarting do not award or erase victories',()=>{
    const db=storage();
    expect(readCampaignProgress(db).started).toBe(false);
    recordCampaignProgress(campaignMissions[0], false, db);
    expect(readCampaignProgress(db)).toEqual({started:true,lastMission:'allied-01',completed:[]});
    recordCampaignProgress(campaignMissions[0], true, db);
    recordCampaignProgress(campaignMissions[0], true, db);
    recordCampaignProgress(campaignMissions[1], false, db);
    expect(campaignCompletion(readCampaignProgress(db))).toBe(8);
    recordCampaignProgress(campaignMissions[0], false, db);
    expect(readCampaignProgress(db).completed).toEqual(['allied-01']);
    recordCampaignProgress(campaignMissions[1], true, db);
    expect(campaignCompletion(readCampaignProgress(db))).toBe(17);
});
test('corrupt and unknown progress entries cannot unlock or credit unimplemented missions',()=>{
    expect(readCampaignProgress(storage('oops'))).toEqual({started:false,completed:[]});
    expect(readCampaignProgress(storage('{"completed":["allied-02","allied-02","bogus"],"lastMission":"bogus"}')))
        .toEqual({started:true,completed:['allied-02'],lastMission:undefined});
});

test('an unavailable persistent store retains session progress without preventing play',()=>{
    const db={getItem:()=>null,setItem:()=>{throw new Error('Storage disabled');}};
    recordCampaignProgress(campaignMissions[0],true,db);
    expect(readCampaignProgress(db).completed).toEqual(['allied-01']);
    expect(readCampaignProgress(storage('null')).started).toBe(false);
});
