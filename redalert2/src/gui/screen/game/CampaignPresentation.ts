import { MapPanningHelper } from '../../../engine/util/MapPanningHelper';

/** Campaign-only UI effects. Never mutates the simulation to advance a mission. */
export class CampaignPresentation {
    private locked?: boolean;
    private menuOpen = false;
    private flashes = new Map<number, number>();
    private video?: HTMLVideoElement;
    private videoViewport = '';
    private readonly positionVideo = (): void => {
        if (!this.video) return;
        const canvas = this.renderer.getCanvas();
        const rect = canvas.getBoundingClientRect();
        const scaleX = rect.width / canvas.clientWidth;
        const scaleY = rect.height / canvas.clientHeight;
        const viewport = this.world.viewport;
        const width = Math.max(1, Math.min(320, viewport.width * scaleX - 24));
        this.video.style.width = `${width}px`;
        this.video.style.left = `${rect.left + (viewport.x + viewport.width) * scaleX - width - 12}px`;
        this.video.style.top = `${rect.top + viewport.y * scaleY + 12}px`;
        this.video.style.maxHeight = `${Math.max(1, viewport.height * scaleY - 24)}px`;
    };
    private resumeVideo = false;
    private readonly onOpen = () => {
        this.menuOpen = true;
        if (this.video) {
            this.resumeVideo = !this.video.paused;
            this.video.pause();
            this.video.hidden = true;
        }
    };
    private readonly onClose = () => {
        this.menuOpen = false;
        this.locked = undefined;
        if (this.video) {
            this.video.hidden = false;
            if (this.resumeVideo) this.video.play().catch(() => {});
        }
        this.resumeVideo = false;
    };
    constructor(private game: any, private renderer: any, private world: any, private interaction: any,
        private sidebar: any, private renderables: any, private menu: any, private manageInput = true) {
        renderer.onFrame.subscribe(this.update);
        menu.onOpen.subscribe(this.onOpen);
        menu.onCancel.subscribe(this.onClose);
        window.addEventListener('resize', this.positionVideo);
    }
    private readonly update = (): void => {
        const campaign = this.game.campaign;
        if (this.video?.isConnected) {
            const viewport = JSON.stringify(this.world.viewport);
            if (viewport !== this.videoViewport) {
                this.videoViewport = viewport;
                this.positionVideo();
            }
        }
        if (this.manageInput && !this.menuOpen && this.locked !== campaign.inputLocked) {
            this.locked = campaign.inputLocked;
            this.interaction.setEnabled(!this.locked);
        }
        for (const event of campaign.presentation.splice(0)) {
            if (event.kind === 'camera') {
                const tile = this.game.map.getTileAtWaypoint(event.waypoint);
                if (tile) this.world.cameraPan.setPan(new MapPanningHelper(this.game.map).computeCameraPanFromTile(tile.rx,tile.ry));
            } else if (event.kind === 'tab') {
                if (event.tab >= 0 && event.tab <= 3) this.sidebar.selectTab?.(event.tab);
            } else if (event.kind === 'flash') {
                for (const id of event.units) this.flashes.set(id, this.game.currentTick + event.frames);
            } else if (event.kind === 'cameo') {
                // Retail action 115 stores a combined techno index, not a rules name.
                const index = Number(event.name);
                const types = ['buildingRules','vehicleRules','infantryRules','aircraftRules'];
                const names = types.flatMap(key => [...this.game.rules[key].values()].map((r: any) => r.name));
                const name = names[index] ?? event.name;
                for (const tab of this.sidebar.tabs ?? []) for (const item of tab.items) {
                    if (item.target?.rules?.name === name) item.campaignFlashUntil = this.game.currentTick + event.frames;
                }
            } else if (event.kind === 'movie') {
                this.video?.remove();
                const video = this.video = document.createElement('video');
                video.src = new URL(`campaign/ra2/allied-01/movie-${event.movie}.mp4`, document.baseURI).href;
                video.autoplay = true; video.controls = false; video.playsInline = true;
                video.style.cssText = 'position:fixed;z-index:2000;background:black;object-fit:contain';
                video.onended = video.onerror = () => video.remove();
                document.body.append(video);
                this.positionVideo();
                video.play().catch(() => video.remove());
            }
        }
        for (const [id, until] of this.flashes) {
            const object = this.game.getWorld().hasObjectId(id) ? this.game.getObjectById(id) : undefined;
            if (!object || object.isDestroyed || this.game.currentTick > until) { this.flashes.delete(id); continue; }
            this.renderables.getRenderableByGameObject(object)?.highlight?.();
        }
    };
    dispose(): void {
        this.renderer.onFrame.unsubscribe(this.update);
        this.menu.onOpen.unsubscribe(this.onOpen);
        this.menu.onCancel.unsubscribe(this.onClose);
        window.removeEventListener('resize', this.positionVideo);
        this.video?.remove();
    }
}
