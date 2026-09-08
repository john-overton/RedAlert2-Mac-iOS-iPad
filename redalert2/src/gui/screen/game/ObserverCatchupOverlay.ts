import type { NetworkMatchSession } from '@/network/client/NetworkMatchSession';

/** Independent of simulation ticks so cancellation stays usable during catch-up. */
export class ObserverCatchupOverlay {
    private readonly element = document.createElement('div');
    private readonly status = document.createElement('span');
    private readonly timer: ReturnType<typeof setInterval>;
    constructor(private readonly match: NetworkMatchSession, returnToLobby: () => void) {
        this.element.className = 'observer-catchup';
        Object.assign(this.element.style, { position: 'absolute', top: '12px', left: '50%', transform: 'translateX(-50%)',
            zIndex: '10000', padding: '8px 12px', background: '#181522ed', color: '#eee', border: '1px solid #9e87bd',
            display: 'flex', gap: '12px', alignItems: 'center', pointerEvents: 'auto' });
        this.status.setAttribute('role', 'status');
        const button = document.createElement('button');
        button.className = 'dialog-button';
        button.textContent = 'Return to Lobby';
        button.onclick = returnToLobby;
        this.element.append(this.status, button);
        for (const event of ['pointerdown', 'pointerup', 'click', 'keydown']) this.element.addEventListener(event, e => e.stopPropagation());
        (document.getElementById('ra2web-root') ?? document.body).append(this.element);
        this.timer = setInterval(() => this.render(), 250);
        this.render();
    }
    private render(): void {
        const { frame, liveFrame } = this.match.getCatchupProgress();
        this.status.textContent = this.match.fatalError ? this.match.fatalError.message
            : this.match.isCatchingUp() ? `Catching up: ${frame.toLocaleString()} / ${liveFrame.toLocaleString()} frames`
            : `Observing live · Frame ${frame.toLocaleString()}`;
    }
    dispose(): void { clearInterval(this.timer); this.element.remove(); }
}
