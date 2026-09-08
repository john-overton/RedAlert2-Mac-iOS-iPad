import { campaignMissionForMap, campaignAssetPath } from '@/data/campaign/CampaignMissions';
import { FileNotFoundError } from '@/data/vfs/FileNotFoundError';
import { VirtualFile } from '@/data/vfs/VirtualFile';
export class MapFileLoader {
    constructor(private resourceLoader: any, private vfs?: any) { }
    async load(filename: string, cancellationToken?: any): Promise<VirtualFile> {
        const sessionMap = this.vfs?.openOverrideFile?.(filename);
        if (sessionMap) return sessionMap;
        const mission = campaignMissionForMap(filename);
        if (mission) {
            const response = await fetch(new URL(campaignAssetPath(mission, mission.map), document.baseURI));
            if (!response.ok) throw new Error(`${mission.title} is not installed in this build`);
            return VirtualFile.fromBytes(new Uint8Array(await response.arrayBuffer()), filename);
        }
        let mapFile: VirtualFile | undefined;
        if (this.vfs) {
            try {
                mapFile = await this.vfs.openFileWithRfs(filename);
            }
            catch (error) {
                if (!(error instanceof FileNotFoundError)) {
                    console.error(error);
                }
            }
        }
        if (!mapFile) {
            const bytes = await this.resourceLoader.loadBinary(filename, cancellationToken);
            mapFile = VirtualFile.fromBytes(bytes, filename);
        }
        return mapFile;
    }
}
