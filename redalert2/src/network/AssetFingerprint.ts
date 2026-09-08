import { Crc32 } from '../data/Crc32';

export interface AssetFileSource {
    getEntries(): AsyncIterable<string>;
    getRawFile(name: string): Promise<File>;
}

/** Fingerprint the imported archives actually in use, including same-size edits.
 * Read in chunks so large MIX files never need a second full copy in memory.
 * Excludes saves, replays, custom maps and cosmetic media. Map/mod identity is
 * checked separately. Cache content CRCs only while size + modification time match.
 */
export async function computeAssetFingerprint(source: AssetFileSource, engine: 'ra2' | 'yr'): Promise<string> {
    const names = new Set<string>();
    for await (const entry of source.getEntries()) {
        if (/\.(mix|bag|idx|csf)$/i.test(entry)) names.add(entry.toLowerCase());
    }
    if (!names.has('ra2.mix') || (engine === 'yr' && !names.has('ra2md.mix'))) {
        throw new Error('Multiplayer requires a local retail asset import. Import the game files first.');
    }
    const records: string[] = [];
    for (const name of [...names].sort()) {
        const file = await source.getRawFile(name);
        const key = `ra2.multiplayer.asset.v1:${name}`;
        let cached: { size: number; modified: number; crc: number } | undefined;
        try { cached = JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined; } catch { /* Storage optional. */ }
        let crc: number;
        if (file.lastModified > 0 && cached?.size === file.size && cached.modified === file.lastModified && Number.isInteger(cached.crc)) {
            crc = cached.crc;
        } else {
            const hash = new Crc32();
            for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
                hash.append(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()));
            }
            crc = hash.get();
            try { localStorage.setItem(key, JSON.stringify({ size: file.size, modified: file.lastModified, crc })); } catch { /* Storage optional. */ }
        }
        records.push(`${name}:${file.size}:${crc.toString(16).padStart(8, '0')}`);
    }
    // Keep the complete sorted manifest: unlike a CRC of CRCs this does not
    // introduce an additional collision across different archive combinations.
    return `assets-v1:${engine}:${records.join('|')}`;
}
