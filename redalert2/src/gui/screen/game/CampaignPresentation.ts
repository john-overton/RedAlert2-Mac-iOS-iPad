import { MapPanningHelper } from '../../../engine/util/MapPanningHelper';

/** Campaign-only UI effects. Never mutates the simulation to advance a mission. */
export class CampaignPresentation {
    private locked?: boolean;
    private menuOpen = false;
    private flashes = new Map<number, number>();
    private video?: HTMLVideoElement;
    private readonly onOpen = () => { this.menuOpen = true; };
    private readonly onClose = () => { this.menuOpen = false; this.locked = undefined; };
    constructor(private game: any, private renderer: any, private world: any, private interaction: any,
        private sidebar: any, private renderables: any, private menu: any) {
        renderer.onFrame.subscribe(this.update);
        menu.onOpen.subscribe(this.onOpen);
        menu.onCancel.subscribe(this.onClose);
    }
    private readonly update = (): void => {
        const campaign = this.game.campaign;
        if (!this.menuOpen && this.locked !== campaign.inputLocked) {
            this.locked = campaign.inputLocked;
            this.interaction.setEnabled(!this.locked);
        }
        for (const event of campaign.presentation.splice(0)) {
            if (event.kind === 'camera') {
                const tile = this.game.map.getTileAtWaypoint(event.waypoint);
                if (tile) this.world.cameraPan.setPan(new MapPanningHelper(this.game.map).computeCameraPanFromTile(tile.rx,tile.ry));
            } else if (event.kind === 'tab') {
                if (event.tab >= 0 && event.tab <= 3) this.sidebar.selectTab(event.tab);
            } else if (event.kind === 'flash') {
                for (const id of event.units) this.flashes.set(id, this.game.currentTick + event.frames);
            } else if (event.kind === 'cameo') {
                // Retail action 115 stores a combined techno index, not a rules name.
                const index = Number(event.name);
                const types = ['buildingRules','vehicleRules','infantryRules','aircraftRules'];
                const names = types.flatMap(key => [...this.game.rules[key].values()].map((r: any) => r.name));
                const name = names[index] ?? event.name;
                for (const tab of this.sidebar.tabs) for (const item of tab.items) {
                    if (item.target?.rules?.name === name) item.campaignFlashUntil = this.game.currentTick + event.frames;
                }
            } else if (event.kind === 'movie') {
                this.video?.remove();
                const video = this.video = document.createElement('video');
                video.src = new URL(`campaign/ra2/allied-01/movie-${event.movie}.mp4`, document.baseURI).href;
                video.autoplay = true; video.controls = true; video.playsInline = true;
                video.style.cssText = 'position:fixed;right:12px;top:64px;width:min(320px,35vw);z-index:2000;background:black';
                video.onended = video.onerror = () => video.remove();
                document.body.append(video);
                video.play().catch(() => { /* Native autoplay policy leaves controls available. */ });
            }
        }
        for (const [id, until] of this.flashes) {
            const object = this.game.getObjectById(id);
            if (!object || object.isDestroyed || this.game.currentTick > until) { this.flashes.delete(id); continue; }
            this.renderables.getRenderableByGameObject(object)?.highlight?.();
        }
    };
    dispose(): void {
        this.renderer.onFrame.unsubscribe(this.update);
        this.menu.onOpen.unsubscribe(this.onOpen);
        this.menu.onCancel.unsubscribe(this.onClose);
        this.video?.remove();
    }
}
