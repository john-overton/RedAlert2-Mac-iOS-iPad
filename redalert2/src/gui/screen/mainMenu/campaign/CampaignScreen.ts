import { jsx } from '@/gui/jsx/jsx';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { campaignMissions, type CampaignMission } from '@/data/campaign/CampaignMissions';
import { readCampaignProgress, type CampaignProgress } from '@/data/campaign/CampaignProgress';
import type { MainMenuController } from '../MainMenuController';
import { CampaignPicker } from './CampaignPicker';

interface CampaignScreenParams {
    installed: readonly CampaignMission[];
    launch: (mission: CampaignMission) => Promise<void>;
}
export class CampaignScreen {
    title = 'Campaigns';
    private controller!: MainMenuController;
    private params!: CampaignScreenParams;
    private missions = false;
    private launching = false;
    constructor(private jsxRenderer: any, private messageBox: any) {}
    setController(controller: MainMenuController): void { this.controller = controller; }
    onEnter(params?: CampaignScreenParams): void {
        if (params) { this.params = params; this.missions = false; }
        this.render();
    }
    private async launch(mission: CampaignMission): Promise<void> {
        if (this.launching) return;
        this.launching = true;
        try { await this.params.launch(mission); }
        catch (error) { await this.messageBox.alert(String(error), 'OK'); }
        finally { this.launching = false; }
    }
    private render(): void {
        this.title = this.missions ? 'Allied Campaign' : 'Campaigns';
        this.controller.setSidebarTitle(this.title);
        this.controller.toggleMainVideo(false);
        const progress: CampaignProgress = readCampaignProgress();
        this.controller.setSidebarButtons([
            ...(this.missions ? [{label:'Start from Beginning',
                disabled:!this.params.installed.some(m => m.id === campaignMissions[0].id),
                tooltip:'Start campaign from beginning; keep completed missions and saves',
                onClick:() => this.launch(campaignMissions[0])}] : []),
            {label:'Back', isBottom:true, onClick:() => {
                if (this.launching) return;
                if (this.missions) { this.missions = false; this.render(); }
                else this.controller.leaveCurrentScreen();
            }},
        ]);
        this.controller.showSidebarButtons();
        const [component] = this.jsxRenderer.render(jsx(HtmlView, {
            width:'100%', height:'100%', component:CampaignPicker,
            props:{missions:this.missions, progress, installed:this.params.installed,
                onCampaign:() => {
                    if (this.launching) return;
                    if (!progress.started && this.params.installed.some(m => m.id === campaignMissions[0].id)) {
                        this.launch(campaignMissions[0]);
                    } else { this.missions = true; this.render(); }
                },
                onMission:(mission: CampaignMission) => this.launch(mission)},
        }));
        this.controller.setMainComponent(component);
    }
    async onLeave(): Promise<void> { await this.controller.hideSidebarButtons(); }
    async onStack(): Promise<void> { await this.onLeave(); }
    onUnstack(): void { this.render(); }
}
