import type { GameOpts } from '../../game/gameopts/GameOpts';
import type { SlotInfo } from '../gameopt/SlotInfo';

export interface SessionClient {
    id: number;
    name: string;
    slotIndex: number | null;
    countryId: number;
    colorId: number;
    startPos: number;
    teamId: number;
    admin: boolean;
    ready: boolean;
    mapReady: boolean;
    contentReady?: string;
    loaded: number;
    ping: number;
}

export interface Session {
    content?: import('../content/ContentPackage').ContentManifest;
    state: 'waiting' | 'started' | 'ended';
    serverName: string;
    clients: SessionClient[];
    slots: SlotInfo[];
    gameOpts: GameOpts;
    orderLatency: number;
    netFrameInterval: number;
    allowSpectators: boolean;
}
