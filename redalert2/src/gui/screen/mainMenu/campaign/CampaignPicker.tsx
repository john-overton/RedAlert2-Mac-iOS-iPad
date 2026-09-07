import React from 'react';
import { campaignMissions, type CampaignMission } from '@/data/campaign/CampaignMissions';
import { alliedCampaignMissionCount, campaignCompletion, type CampaignProgress } from '@/data/campaign/CampaignProgress';

export function CampaignPicker({missions, progress, installed, onCampaign, onMission}: {
    missions: boolean; progress: CampaignProgress; installed: readonly CampaignMission[];
    onCampaign: () => void; onMission: (mission: CampaignMission) => void;
}) {
    return <div className="opts general-opts campaign-picker" role="region" aria-label={missions ? 'Allied campaign' : 'Campaign selection'}>
        <fieldset>
            <legend>{missions ? 'Allied Campaign' : 'Select Campaign'}</legend>
            <p>{missions
                ? `${campaignCompletion(progress)}% complete · ${progress.completed.length} of ${alliedCampaignMissionCount} missions completed. ${installed.length} missions available in this build.`
                : 'Choose a campaign.'}</p>
            {missions ? <>
                <progress aria-label="Campaign completion" max={alliedCampaignMissionCount} value={progress.completed.length}/>
                {Array.from({length:alliedCampaignMissionCount}, (_, i) => {
                    const mission = campaignMissions[i];
                    const available = mission && installed.some(entry => entry.id === mission.id);
                    const status = mission && progress.completed.includes(mission.id) ? ' — Completed' : '';
                    return <button key={i} className="campaign-choice" disabled={!available}
                        onClick={() => onMission(mission)}>
                        {mission ? `${mission.label}: ${mission.title}${available ? status : ' — Not installed'}` : `Mission ${i + 1} — Coming soon`}
                    </button>;
                })}
            </> : <>
                <button className="campaign-choice" onClick={onCampaign} disabled={!installed.length}>
                    <strong>Red Alert 2 — Allied</strong>
                    <span>{campaignCompletion(progress)}% complete · {progress.started ? 'Choose a mission' : 'Start campaign'}</span>
                </button>
                {['Red Alert 2 — Soviet', 'Yuri’s Revenge — Allied', 'Yuri’s Revenge — Soviet'].map(name =>
                    <button key={name} className="campaign-choice" disabled>
                        <strong>{name}</strong><span>Coming soon</span>
                    </button>)}
            </>}
        </fieldset>
        {missions && <p>Starting again keeps your completed missions and saved games.</p>}
    </div>;
}
