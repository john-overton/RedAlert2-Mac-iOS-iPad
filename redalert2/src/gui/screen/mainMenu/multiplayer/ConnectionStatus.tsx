import React from 'react';
import { CONNECTION_WARNING_MS, type ConnectionHealth } from '@/network/ConnectionHealth';

export function ConnectionStatus({health, players}: {
    health?: ConnectionHealth & {serverIdleMs:number};
    players: {id:number; name:string}[];
}) {
    return <div className="mp-connections" role="group" aria-label="Connection status">
        <span className="mp-ping-label">Ping to host</span>
        <div className="mp-pings">
            {players.map(player => {
                const status = health?.players.find(value => value.clientId === player.id);
                const stalled = status && status.idleMs >= CONNECTION_WARNING_MS;
                const slow = status?.ping != null && status.ping >= 250;
                return <span key={player.id} className={`mp-ping${stalled ? ' mp-ping-stalled' : slow ? ' mp-ping-slow' : ''}`}>
                    <span>{player.name}</span>
                    <strong title="Round-trip time between this player and the host">
                        {status?.ping == null ? 'Measuring…' : `${Math.round(status.ping)} ms`}
                    </strong>
                    {stalled && <span>No reply for {Math.floor(status.idleMs / 1000)} s · slot held for {Math.max(0, Math.ceil((health!.timeoutMs - status.idleMs) / 1000))} s</span>}
                </span>;
            })}
        </div>
        {health && health.serverIdleMs >= CONNECTION_WARNING_MS && <p role="status">
            The host has not responded for {Math.floor(health.serverIdleMs / 1000)} seconds. Waiting for the connection to recover…
        </p>}
    </div>;
}
