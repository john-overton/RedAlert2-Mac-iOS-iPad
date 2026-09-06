import { campaignAssetPath, type CampaignMission } from '@/data/campaign/CampaignMissions';
import { Engine } from '@/engine/Engine';
import { MainMenuRoute } from '../mainMenu/MainMenuRoute';
import { MainMenuScreenType } from '../ScreenType';
import { playCampaignIntro } from './playCampaignIntro';

export async function loadCampaignManifest(mission: CampaignMission): Promise<any | undefined> {
    return fetch(new URL(campaignAssetPath(mission, 'manifest.json'), document.baseURI))
        .then(response => response.ok ? response.json() : undefined).catch(() => undefined);
}

/** New scenario state comes from the map. These retail missions carry no money or units. */
export async function launchCampaign(mission: CampaignMission, manifest: any, controller: any,
    strings: any, messageBox: any): Promise<void> {
    const file = manifest.files?.find((file: any) => file.path === mission.map);
    if (!file) throw new Error(`${mission.title} is not installed in this build`);
    await messageBox.alert(strings.get(mission.briefing) || mission.title, 'Begin Mission');
    for (const alias of ['intro', 'brief']) {
        if (manifest.media?.some((clip: any) => clip.alias === alias)) {
            await playCampaignIntro(campaignAssetPath(mission, `${alias}.mp4`));
        }
    }
    const player = manifest.playerHouse ?? (mission.id === 'allied-01' ? 'Player House' : 'Americans');
    const gameOpts = {gameMode:Engine.getMpModes().getAll()[0].id, gameSpeed:3,
        credits:100, unitCount:0, shortGame:false, superWeapons:true, buildOffAlly:false,
        mcvRepacks:false, cratesAppear:false, destroyableBridges:true, multiEngineer:false,
        noDogEngiKills:false, mapName:mission.map, mapTitle:mission.title, mapDigest:'',
        mapSizeBytes:file.size, maxSlots:8, mapOfficial:true,
        humanPlayers:[{name:player,countryId:0,colorId:0,startPos:0,teamId:0}], aiPlayers:[]};
    controller.createGame(crypto.randomUUID(),Math.floor(Date.now()/1000)*1000,'',player,
        gameOpts,true,false,false,false,new MainMenuRoute(MainMenuScreenType.Home,{}));
}
