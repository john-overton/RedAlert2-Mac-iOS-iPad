import { HANDSHAKE_PROTOCOL, ORDERS_PROTOCOL } from './server/Protocol';
import { Engine } from '../engine/Engine';
import { version } from '../version';
import { computeAssetFingerprint } from './AssetFingerprint';
import type { ProtocolIdentity } from './server/Protocol';

export async function createMultiplayerIdentity(engineType: string): Promise<ProtocolIdentity> {
    const engine = engineType === 'yr' ? 'yr' : 'ra2';
    if (!Engine.rfs) throw new Error('Game files have not been loaded.');
    return {
        protocol: HANDSHAKE_PROTOCOL, ordersProtocol: ORDERS_PROTOCOL, engine,
        mod: Engine.getActiveMod() ?? 'base',
        version, modHash: String(Engine.getModHash()),
        assetFingerprint: await computeAssetFingerprint(Engine.rfs, engine),
    };
}
