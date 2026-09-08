import type { ConnectionHealth } from '../ConnectionHealth';
import type { GameOpts } from '../../game/gameopts/GameOpts';
import type { Session } from './Session';

export const HANDSHAKE_PROTOCOL = 4;
export const ORDERS_PROTOCOL = 3;
export const MAX_PACKET_BYTES = 128 * 1024;
export const DEFAULT_PORT = 1620;

export interface ProtocolIdentity {
    protocol: number;
    ordersProtocol: number;
    engine: 'ra2' | 'yr';
    mod: string;
    version: string;
    modHash: string;
    assetFingerprint: string;
}
export interface HelloMessage extends ProtocolIdentity {
    type: 'hello';
    name: string;
    role?: 'player' | 'observer';
    password?: string;
    preferredCountry?: number;
    preferredColor?: number;
}
export interface HumanAssignment { clientId: number; slotIndex: number; name: string }
export interface StartGameMessage {
    type: 'startGame';
    observer?: boolean;
    observationId?: number;
    liveFrame?: number;
    gameId: string;
    generation: number;
    timestamp: number;
    gameOpts: GameOpts;
    humanAssignments: HumanAssignment[];
    clientIds: number[];
    orderLatency: number;
    netFrameInterval: number;
}
export type ClientMessage = ContentRequest | HelloMessage
    | { type: 'command'; name: string; args?: Record<string, unknown> }
    | { type: 'chat'; to: 'all' | 'team' | 'observers' | number; text: string }
    | { type: 'history'; observationId: number; gameId: string; generation: number; fromFrame: number; maxFrames?: number }
    | { type: 'loaded'; gameId: string; generation: number; percent: number }
    | { type: 'returnToLobby'; observationId?: number; gameId: string; generation: number; reason: 'finished' | 'forfeit' }
    | { type: 'ping' | 'pong'; t: number; queueLength?: number };
export type ContentRequest = { type: 'content'; requestId: number; action: 'begin' | 'put' | 'commit' | 'get' | 'cancel'; manifest?: import('../content/ContentPackage').ContentManifest; id?: string; path?: string; offset?: number; data?: string };
export type ContentResponse = { type: 'contentResult'; requestId: number; error?: string; data?: string };
export interface ChatIdentity { name: string; colorId: number; teamId: number }
export interface ObserverFrame { frame: number; orders: { clientId: number; actions: string }[]; drops: { clientId: number; frame: number; takeover?: 'ai' }[]; hash: number; defeatMask: string }
export type ServerMessage = ContentResponse
    | { type: 'history'; observationId: number; gameId: string; generation: number; fromFrame: number; frames: ObserverFrame[]; liveFrame: number; allLoaded: boolean }
    | ({ type: 'connectionHealth' } & ConnectionHealth)
    | { type: 'welcome'; clientId: number; session: Session }
    | { type: 'session'; session: Session }
    | { type: 'error'; code: string; message?: string }
    | { type: 'chat'; clientId: number; to: 'all' | 'team' | 'observers' | number; text: string; sender: ChatIdentity; recipient?: ChatIdentity }
    | { type: 'message'; key: string; args?: Record<string, unknown> }
    | { type: 'matchEnded'; gameId: string; generation: number; reason: 'finished' | 'abandoned' | 'desync' }
    | StartGameMessage
    | { type: 'loaded'; generation: number; clientId: number; percent: number }
    | { type: 'allLoaded'; generation: number }
    | { type: 'ack'; generation: number; frame: number; count: number }
    | { type: 'disconnect'; generation: number; clientId: number; frame: number; takeover?: 'ai' }
    | { type: 'matchHealth'; generation: number; players: { clientId: number; ping: number | null; lagMs: number }[] }
    | { type: 'outOfSync'; generation: number; frame: number }
    | { type: 'ping' | 'pong'; t: number; queueLength?: number };

export interface OrderPacket { kind: 'orders'; generation: number; clientId: number; frame: number; actions: Uint8Array }
export interface SyncPacket { kind: 'sync'; generation: number; frame: number; hash: number; defeatMask: bigint }
/** Only the server may send this packet; the sender id comes from its connection. */
export interface RelayedSyncPacket { kind: 'syncRelay'; generation: number; clientId: number; frame: number; hash: number; defeatMask: bigint }

export function encodeOrderPacket(clientId: number, frame: number, actions: Uint8Array, generation = 0): Uint8Array {
    if (actions.length + 13 > MAX_PACKET_BYTES) throw new Error('Order packet is too large');
    const bytes = new Uint8Array(13 + actions.length);
    const view = new DataView(bytes.buffer);
    bytes[0] = 1;
    view.setUint32(1, generation, true);
    view.setUint32(5, clientId, true);
    view.setUint32(9, frame, true);
    bytes.set(actions, 13);
    return bytes;
}
export function encodeSyncPacket(frame: number, hash: number, defeatMask = 0n, generation = 0): Uint8Array {
    const bytes = new Uint8Array(21);
    const view = new DataView(bytes.buffer);
    bytes[0] = 2;
    view.setUint32(1, generation, true);
    view.setUint32(5, frame, true);
    view.setUint32(9, hash, true);
    view.setBigUint64(13, defeatMask, true);
    return bytes;
}
export function encodeRelayedSyncPacket(clientId: number, frame: number, hash: number, defeatMask = 0n, generation = 0): Uint8Array {
    const bytes = new Uint8Array(25);
    const view = new DataView(bytes.buffer);
    bytes[0] = 3;
    view.setUint32(1, generation, true);
    view.setUint32(5, clientId, true);
    bytes.set(encodeSyncPacket(frame, hash, defeatMask, generation).subarray(5), 9);
    return bytes;
}
export function decodePacket(bytes: Uint8Array): OrderPacket | SyncPacket | RelayedSyncPacket {
    if (bytes.length > MAX_PACKET_BYTES || bytes.length < 13) throw new Error('Invalid packet size');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const generation = view.getUint32(1, true);
    if (bytes[0] === 1) return { kind: 'orders', generation, clientId: view.getUint32(5, true), frame: view.getUint32(9, true), actions: bytes.slice(13) };
    if (bytes[0] === 2 && bytes.length === 21) return { kind: 'sync', generation, frame: view.getUint32(5, true), hash: view.getUint32(9, true), defeatMask: view.getBigUint64(13, true) };
    if (bytes[0] === 3 && bytes.length === 25) return { kind: 'syncRelay', generation, clientId: view.getUint32(5, true), frame: view.getUint32(9, true), hash: view.getUint32(13, true), defeatMask: view.getBigUint64(17, true) };
    throw new Error('Unknown packet kind');
}

export type ServerIdentity = ProtocolIdentity;
