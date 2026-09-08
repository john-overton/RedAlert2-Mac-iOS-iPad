import React from 'react';
import { createRoot } from 'react-dom/client';
import { NetworkMatchSession } from '@/network/client/NetworkMatchSession';
import { NetworkTurnManager } from '@/network/client/NetworkTurnManager';
import './networkStall.css';

/** Uses a wall-clock UI timer: the simulation itself is stopped while waiting. */
export class NetworkStallOverlay {
    private readonly element = document.createElement('div');
    private readonly root = createRoot(this.element);
    private readonly timer: ReturnType<typeof setInterval>;
    private pending = new Set<number>();
    private waiting = false;
    constructor(private readonly match: NetworkMatchSession, private readonly turns: NetworkTurnManager,
        private readonly viewport: () => { x: number; y: number; width: number; height: number }) {
        this.element.className = 'network-stall-layer';
        (document.getElementById('ra2web-root') ?? document.body).append(this.element);
        this.timer = setInterval(() => this.render(), 250);
    }
    private render(): void {
        const duration = this.turns.getStallDuration();
        const reconnecting = this.match.connection.isReconnecting;
        if ((!reconnecting && duration < 1500) || this.match.fatalError) {
            this.root.render(null); this.pending.clear(); this.waiting = false; return;
        }
        if (this.match.controlError) this.pending.clear();
        const viewport = this.viewport();
        Object.assign(this.element.style, { left: `${viewport.x}px`, top: `${viewport.y}px`, width: `${viewport.width}px`, height: `${viewport.height}px` });
        const active = this.match.getSnapshot().activePeerIds;
        const lagging = this.match.matchHealth.filter(player => player.lagMs >= 1500 && active.includes(String(player.clientId)));
        const host = this.match.isHost();
        this.root.render(<div className="network-stall-panel" role="status" aria-live="polite"
            onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <strong>{reconnecting ? 'Reconnecting…' : 'Synchronizing game…'}</strong>
            <p>{reconnecting ? 'Reconnecting automatically for up to 30 seconds. Keep this window open to retain control of your army.' : `Waiting for the connection to recover. ${Math.floor(duration / 1000)}s`}</p>
            {host && !reconnecting && <>
                {lagging.length ? lagging.map(player => <div className="network-stall-player" key={player.clientId}>
                    <span>{this.match.getHumanAssignment(String(player.clientId))?.name ?? 'Player'}
                        {String(player.clientId) === this.match.descriptor.localPeerId ? ' (you)' : ''}
                        {' · '}{player.ping === null ? 'Ping unavailable' : `${Math.round(player.ping)} ms ping`}</span>
                    {String(player.clientId) !== this.match.descriptor.localPeerId && <button disabled={this.pending.has(player.clientId)} onClick={() => {
                        this.pending.add(player.clientId); this.match.kickToAi(player.clientId); this.render();
                    }}>Kick &amp; replace with AI</button>}
                </div>) : <p>Waiting for player or server progress…</p>}
                {this.match.controlError && <p role="alert">{this.match.controlError}</p>}
                <button onClick={() => { this.waiting = true; this.render(); }}>Keep waiting</button>
                {this.waiting && <p>Waiting for recovery; the game resumes automatically.</p>}
            </>}
        </div>);
    }
    dispose(): void { clearInterval(this.timer); this.root.unmount(); this.element.remove(); }
}
