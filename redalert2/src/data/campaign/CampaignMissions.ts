/** Explicit retail campaign order: map Basic.NextScenario contains legacy placeholders. */
export const campaignMissions = [
    {id:'allied-01', map:'all01t.map', title:'Lone Guardian', label:'Mission One', briefing:'Brief:ALL01', next:'allied-02'},
    {id:'allied-02', map:'all02s.map', title:'Eagle Dawn', label:'Mission Two', briefing:'Brief:ALL02', next:undefined},
] as const;
export type CampaignMission = typeof campaignMissions[number];
export function campaignMissionForMap(map: string): CampaignMission | undefined {
    return campaignMissions.find(mission => mission.map === map.toLowerCase());
}
export function campaignAssetPath(mission: CampaignMission, file: string): string {
    return `campaign/ra2/${mission.id}/${file}`;
}
