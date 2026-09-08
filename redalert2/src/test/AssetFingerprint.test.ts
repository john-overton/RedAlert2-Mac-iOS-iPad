import { describe, expect, test } from 'bun:test';
import { computeAssetFingerprint, type AssetFileSource } from '../network/AssetFingerprint';
function source(entries: Record<string, string>): AssetFileSource {
    return {
        async *getEntries() { yield* Object.keys(entries); },
        async getRawFile(name) { return new File([entries[name]], name, { lastModified: 0 }); },
    };
}
describe('retail asset fingerprint', () => {
    test('stable across enumeration order, excludes saves and custom maps', async () => {
        const a = await computeAssetFingerprint(source({ 'ra2.mix': 'abc', 'language.mix': 'def' }), 'ra2');
        const b = await computeAssetFingerprint(source({ 'language.mix': 'def', 'ra2.mix': 'abc', 'save.sav': 'save', 'custom.map': 'map' }), 'ra2');
        expect(a).toBe(b);
    });
    test('same-length retail modifications and engine variants differ', async () => {
        const a = source({ 'ra2.mix': 'abc', 'ra2md.mix': 'yr' });
        expect(await computeAssetFingerprint(a, 'ra2')).not.toBe(await computeAssetFingerprint(source({ 'ra2.mix': 'abd', 'ra2md.mix': 'yr' }), 'ra2'));
        expect(await computeAssetFingerprint(a, 'ra2')).not.toBe(await computeAssetFingerprint(a, 'yr'));
    });
    test('missing retail data cannot produce a permissive fallback identity', async () => {
        await expect(computeAssetFingerprint(source({}), 'ra2')).rejects.toThrow('local retail');
        await expect(computeAssetFingerprint(source({ 'ra2.mix': 'abc' }), 'yr')).rejects.toThrow('local retail');
    });
});
