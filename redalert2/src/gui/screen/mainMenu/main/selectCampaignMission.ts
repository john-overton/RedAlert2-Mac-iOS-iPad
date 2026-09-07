import { campaignMissions, type CampaignMission } from '@/data/campaign/CampaignMissions';
import { alliedCampaignMissionCount, campaignCompletion, type CampaignProgress } from '@/data/campaign/CampaignProgress';

/** Future missions are placeholders; only installed, implemented scenarios can launch. */
export function selectCampaignMission(progress: CampaignProgress, installed: readonly CampaignMission[]): Promise<CampaignMission | undefined> {
    return new Promise(resolve => {
        const previousFocus = document.activeElement as HTMLElement | null;
        const dialog = document.createElement('dialog');
        dialog.setAttribute('aria-label', 'Allied campaign');
        dialog.style.cssText = 'box-sizing:border-box;width:min(640px,94vw);max-height:90vh;overflow:auto;background:#160b0b;color:#eee;border:2px solid #ae3434;padding:24px;font:16px Arial,sans-serif;';
        const title = document.createElement('h2');
        title.textContent = 'Allied Campaign';
        dialog.append(title);
        const description = document.createElement('p');
        description.textContent = `${campaignCompletion(progress)}% complete · ${progress.completed.length} of ${alliedCampaignMissionCount} missions completed. ${installed.length} missions available in this build.`;
        dialog.append(description);
        const meter = document.createElement('progress');
        meter.max = alliedCampaignMissionCount;
        meter.value = progress.completed.length;
        meter.setAttribute('aria-label', 'Campaign completion');
        meter.style.width = '100%';
        meter.style.accentColor = '#c33';
        dialog.append(meter);
        const missionList = document.createElement('div');
        missionList.style.cssText = 'max-height:45vh;overflow-y:auto;margin:12px 0;';
        dialog.append(missionList);
        const finish = (mission?: CampaignMission) => {
            dialog.close(); dialog.remove(); previousFocus?.focus(); resolve(mission);
        };
        const button = (label: string, onClick: () => void, disabled = false) => {
            const el = document.createElement('button');
            el.type = 'button'; el.textContent = label; el.disabled = disabled;
            el.style.cssText = `display:block;width:100%;text-align:left;margin:10px 0;padding:12px;background:#352020;color:${disabled ? '#999' : '#fff'};border:1px solid #884444;font:inherit;cursor:${disabled ? 'default' : 'pointer'};`;
            el.onclick = onClick; return el;
        };
        for (let i = 0; i < alliedCampaignMissionCount; i++) {
            const mission = campaignMissions[i];
            const available = mission && installed.some(entry => entry.id === mission.id);
            const status = mission && progress.completed.includes(mission.id) ? ' — Completed' : '';
            const choice = button(mission ? `${mission.label}: ${mission.title}${available ? status : ' — Not installed'}` : `Mission ${i + 1} — Coming soon`,
                () => finish(mission), !available);
            choice.autofocus = !!available && mission.id === (progress.lastMission ?? campaignMissions[0].id);
            missionList.append(choice);
        }
        dialog.append(button('Start campaign from beginning', () => finish(campaignMissions[0]), !installed.some(m => m.id === campaignMissions[0].id)));
        const note = document.createElement('p');
        note.textContent = 'Starting again keeps your completed missions and saved games.';
        dialog.append(note);
        dialog.append(button('Back', () => finish()));
        dialog.addEventListener('cancel', event => {event.preventDefault(); finish();});
        document.body.append(dialog);
        dialog.showModal();
    });
}
