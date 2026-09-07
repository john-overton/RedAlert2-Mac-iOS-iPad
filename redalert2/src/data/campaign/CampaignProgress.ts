import { campaignMissions, type CampaignMission } from './CampaignMissions';

export const campaignProgressKey = 'ra2.alliedCampaign.progress.v1';
export const alliedCampaignMissionCount = 12;
export interface CampaignProgress {
    started: boolean;
    lastMission?: CampaignMission['id'];
    completed: CampaignMission['id'][];
}
type ProgressStorage = Pick<Storage, 'getItem' | 'setItem'>;
let sessionProgress: CampaignProgress = {started:false, completed:[]};
const failedWrites = new WeakMap<ProgressStorage, CampaignProgress>();
function browserStorage(): ProgressStorage | undefined {
    try { return globalThis.localStorage; } catch { return undefined; }
}
export function readCampaignProgress(storage = browserStorage()): CampaignProgress {
    if (!storage || failedWrites.has(storage)) {
        const progress = (storage && failedWrites.get(storage)) || sessionProgress;
        return {...progress, completed:[...progress.completed]};
    }
    try {
        const value = JSON.parse(storage?.getItem(campaignProgressKey) ?? 'null');
        if (!value || typeof value !== 'object') return {started:false, completed:[]};
        const valid = (id: unknown): id is CampaignMission['id'] => campaignMissions.some(m => m.id === id);
        const completed = Array.isArray(value.completed) ? [...new Set(value.completed.filter(valid))] as CampaignMission['id'][] : [];
        return {started:value.started === true || completed.length > 0,
            lastMission:valid(value.lastMission) ? value.lastMission : undefined, completed};
    } catch { return {started:false, completed:[]}; }
}
export function recordCampaignProgress(mission: CampaignMission, completed = false, storage = browserStorage()): void {
    const progress = readCampaignProgress(storage);
    progress.started = true;
    progress.lastMission = mission.id;
    if (completed && !progress.completed.includes(mission.id)) progress.completed.push(mission.id);
    sessionProgress = progress;
    try { storage?.setItem(campaignProgressKey, JSON.stringify(progress)); }
    catch { if (storage) failedWrites.set(storage, progress); }
}
export function campaignCompletion(progress: CampaignProgress): number {
    return Math.round(progress.completed.length / alliedCampaignMissionCount * 100);
}
