import type { ConnectionHealth } from '../ConnectionHealth';
import type { GameOpts } from '../../game/gameopts/GameOpts';
import type { Session } from './Session';

export const HANDSHAKE_PROTOCOL = 2;
export const ORDERS_PROTOCOL = 2;
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
    password?: string;
    preferredCountry?: number;
    preferredColor?: number;
}
export interface HumanAssignment { clientId: number; slotIndex: number; name: string }
export interface StartGameMessage {
    type: 'startGame';
    gameId: string;
    timestamp: number;
    gameOpts: GameOpts;
    humanAssignments: HumanAssignment[];
    clientIds: number[];
    orderLatency: number;
    netFrameInterval: number;
}
export type ClientMessage = ContentRequest | HelloMessage
    | { type: 'command'; name: string; args?: Record<string, unknown> }
    | { type: 'chat'; to: 'all' | 'team' | number; text: string }
    | { type: 'loaded'; percent: number }
    | { type: 'ping' | 'pong'; t: number; queueLength?: number };
export type ContentRequest = { type: 'content'; requestId: number; action: 'begin' | 'put' | 'commit' | 'get' | 'cancel'; manifest?: import('../content/ContentPackage').ContentManifest; id?: string; path?: string; offset?: number; data?: string };
export type ContentResponse = { type: 'contentResult'; requestId: number; error?: string; data?: string };
export type ServerMessage = ContentResponse
    | ({ type: 'connectionHealth' } & ConnectionHealth)
    | { type: 'welcome'; clientId: number; session: Session }
    | { type: 'session'; session: Session }
    | { type: 'error'; code: string; message?: string }
    | { type: 'chat'; clientId: number; to: 'all' | 'team' | number; text: string }
    | { type: 'message'; key: string; args?: Record<string, unknown> }
    | StartGameMessage
    | { type: 'loaded'; clientId: number; percent: number }
    | { type: 'allLoaded' }
    | { type: 'ack'; frame: number; count: number }
    | { type: 'disconnect'; clientId: number; frame: number }
    | { type: 'outOfSync'; frame: number }
    | { type: 'ping' | 'pong'; t: number; queueLength?: number };

export interface OrderPacket { kind: 'orders'; clientId: number; frame: number; actions: Uint8Array }
export interface SyncPacket { kind: 'sync'; frame: number; hash: number; defeatMask: bigint }

export function encodeOrderPacket(clientId: number, frame: number, actions: Uint8Array): Uint8Array {
    if (actions.length + 9 > MAX_PACKET_BYTES) throw new Error('Order packet is too large');
    const bytes = new Uint8Array(9 + actions.length);
    const view = new DataView(bytes.buffer);
    bytes[0] = 1;
    view.setUint32(1, clientId, true);
    view.setUint32(5, frame, true);
    bytes.set(actions, 9);
    return bytes;
}
export function encodeSyncPacket(frame: number, hash: number, defeatMask = 0n): Uint8Array {
    const bytes = new Uint8Array(17);
    const view = new DataView(bytes.buffer);
    bytes[0] = 2;
    view.setUint32(1, frame, true);
    view.setUint32(5, hash, true);
    view.setBigUint64(9, defeatMask, true);
    return bytes;
}
/** Only the server may send this packet; the sender id comes from its connection. */
export interface RelayedSyncPacket { kind: 'syncRelay'; clientId: number; frame: number; hash: number; defeatMask: bigint }
export function encodeRelayedSyncPacket(clientId: number, frame: number, hash: number, defeatMask = 0n): Uint8Array {
    const bytes = new Uint8Array(21);
    const view = new DataView(bytes.buffer);
    bytes[0] = 3;
    view.setUint32(1, clientId, true);
    bytes.set(encodeSyncPacket(frame, hash, defeatMask).subarray(1), 5);
    return bytes;
}
export function decodePacket(bytes: Uint8Array): OrderPacket | SyncPacket | RelayedSyncPacket {
    if (bytes.length > MAX_PACKET_BYTES || bytes.length < 9) throw new Error('Invalid packet size');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 1) return { kind: 'orders', clientId: view.getUint32(1, true), frame: view.getUint32(5, true), actions: bytes.slice(9) };
    if (bytes[0] === 2 && bytes.length === 17) return { kind: 'sync', frame: view.getUint32(1, true), hash: view.getUint32(5, true), defeatMask: view.getBigUint64(9, true) };
    if (bytes[0] === 3 && bytes.length === 21) return { kind: 'syncRelay', clientId: view.getUint32(1, true), frame: view.getUint32(5, true), hash: view.getUint32(9, true), defeatMask: view.getBigUint64(13, true) };
    throw new Error('Unknown packet kind');
}

export type ServerIdentity = ProtocolIdentity;
