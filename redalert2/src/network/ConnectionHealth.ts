/** Wall-clock liveness limits, independent of deterministic game ticks. */
export const HEARTBEAT_INTERVAL_MS = 5000;
export const CONNECTION_WARNING_MS = 10000;
export const CONNECTION_TIMEOUT_MS = 120000;
export const HANDSHAKE_TIMEOUT_MS = 30000;

export interface PlayerConnectionHealth {
    clientId: number;
    /** Round-trip time to the host; null until the first heartbeat reply. */
    ping: number | null;
    idleMs: number;
}
export interface ConnectionHealth {
    players: PlayerConnectionHealth[];
    timeoutMs: number;
}
