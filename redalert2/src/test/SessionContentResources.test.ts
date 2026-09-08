import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Engine } from '../engine/Engine';
import { IniFile } from '../data/IniFile';
import { Strings } from '../data/Strings';
import { VirtualFile } from '../data/vfs/VirtualFile';
import { VirtualFileSystem } from '../data/vfs/VirtualFileSystem';
import { MemArchive } from '../data/vfs/MemArchive';
import { LazyResourceCollection } from '../engine/LazyResourceCollection';
import { MapFileLoader } from '../gui/screen/game/MapFileLoader';
import { mountSessionContent, restoreSessionContent, hasSessionContent } from '../network/content/SessionContentResources';

const encode = (text: string) => new TextEncoder().encode(text);
const logger = { info() {}, warn() {}, error() {} };
const originals = { vfs: Engine.vfs, rules: Engine.rules, art: Engine.art, ai: Engine.ai, theaters: Engine.theaters, activeTheater: Engine.activeTheater };
let restoreCollections: (() => void)[] = [];
beforeEach(() => {
    Engine.vfs = new VirtualFileSystem(undefined!, logger);
    restoreCollections = [Engine.iniFiles, Engine.images, Engine.voxels, Engine.voxelAnims, Engine.palettes, Engine.tileData, Engine.sounds].map(collection => {
        const restore = collection.beginOverlay(new Set());
        collection.clearAll();
        collection.setVfs(Engine.vfs!);
        return () => { restore(); collection.setVfs(originals.vfs!); };
    });
    Engine.rules = new IniFile('[VehicleTypes]\n0=MTNK\n[MTNK]\nCost=800\n[General]\nEngineFix=yes');
    Engine.art = new IniFile('[MTNK]\nVoxel=yes');
    Engine.ai = new IniFile('[AI]\nOriginal=yes');
});
afterEach(() => {
    restoreSessionContent();
    restoreCollections.forEach(restore => restore());
    Object.assign(Engine, originals);
});

describe('session resource overlays', () => {
    test('custom units merge into baseline and original objects return on leave', () => {
        const baseline = Engine.rules;
        const baselineArt = Engine.art;
        mountSessionContent(new Map([
            ['rulescd.ini', encode('[VehicleTypes]\n9999=HOSTTANK\n[HOSTTANK]\nCost=123\n[MTNK]\nCost=777')],
            ['artcd.ini', encode('[HOSTTANK]\nVoxel=yes\nCameo=hosticon')],
            ['hosttank.vxl', encode('fixture')], ['hosttank.hva', encode('fixture')], ['hosticon.shp', encode('fixture')],
        ]));
        expect(Engine.rules!.getSection('VehicleTypes')!.getString('0')).toBe('MTNK');
        expect([...Engine.rules!.getSection('VehicleTypes')!.entries.values()]).toContain('HOSTTANK');
        expect(Engine.rules!.getSection('HOSTTANK')!.getNumber('Cost')).toBe(123);
        expect(Engine.rules!.getSection('General')!.getString('EngineFix')).toBe('yes');
        expect(Engine.art!.getSection('HOSTTANK')!.getString('Cameo')).toBe('hosticon');
        expect(baseline!.getSection('MTNK')!.getNumber('Cost')).toBe(800);
        restoreSessionContent();
        expect(Engine.rules).toBe(baseline);
        expect(Engine.art).toBe(baselineArt);
        expect(Engine.rules!.getSection('HOSTTANK')).toBeUndefined();
        expect(Engine.vfs!.fileExists('rulescd.ini')).toBe(false);
        expect(hasSessionContent()).toBe(false);
    });
    test('VFS overrides retail case-insensitively, owns bytes and resets parser cursors', () => {
        const retail = new MemArchive();
        retail.addFile(VirtualFile.fromBytes(encode('retail'), 'unit.shp'));
        Engine.vfs!.addArchive(retail, 'retail');
        const custom = encode('custom');
        mountSessionContent(new Map([['unit.shp', custom], ['host.map', encode('[Basic]\nName=Host')]]));
        custom.fill(0);
        expect(Engine.vfs!.openFile('UNIT.SHP').readAsString()).toBe('custom');
        const first = Engine.vfs!.openFile('host.map');
        first.stream.seek(3);
        expect(Engine.vfs!.openFile('host.map').stream.position).toBe(0);
        restoreSessionContent();
        expect(Engine.vfs!.openFile('unit.shp').readAsString()).toBe('retail');
        expect(Engine.vfs!.fileExists('host.map')).toBe(false);
    });
    test('replacement invalidates cached files and restores injected baseline resources', () => {
        const cache = new LazyResourceCollection(file => file.readAsString());
        cache.setVfs(Engine.vfs!);
        cache.set('unit.shp', 'cached retail');
        cache.set('cdn-only.shp', 'preloaded');
        mountSessionContent(new Map([['unit.shp', encode('host graphics')]]));
        const restore = cache.beginOverlay(new Set(['unit.shp']));
        expect(cache.get('unit.shp')).toBe('host graphics');
        expect(cache.get('cdn-only.shp')).toBe('preloaded');
        restore();
        restore();
        expect(cache.get('unit.shp')).toBe('cached retail');
    });
    test('host map takes priority over a different loose import with the same filename', async () => {
        let importedReads = 0;
        Engine.vfs = new VirtualFileSystem({
            async openFile(filename: string) { importedReads++; return VirtualFile.fromBytes(encode('guest version'), filename); },
        } as any, logger);
        const loader = new MapFileLoader({ loadBinary() { throw new Error('Unexpected fallback download'); } }, Engine.vfs);
        mountSessionContent(new Map([['host.map', encode('host version')]]));
        expect((await loader.load('host.map')).readAsString()).toBe('host version');
        expect((await Engine.vfs.openFileWithRfs('host.map'))!.readAsString()).toBe('host version');
        expect(importedReads).toBe(0);
        restoreSessionContent();
        expect((await loader.load('host.map')).readAsString()).toBe('guest version');
        expect(importedReads).toBe(1);
    });
    test('INI resource patch preserves definitions used by lazy loaders', () => {
        const baseline = new IniFile('[ExistingSound]\nSounds=old\n[Defaults]\nVolume=60');
        Engine.iniFiles.set('sound.ini', baseline);
        mountSessionContent(new Map([['sound.ini', encode('[HostSound]\nSounds=custom')]]));
        const merged = Engine.getIni('sound.ini');
        expect(merged.getSection('HostSound')!.getString('Sounds')).toBe('custom');
        expect(merged.getSection('ExistingSound')!.getString('Sounds')).toBe('old');
        restoreSessionContent();
        expect(Engine.getIni('sound.ini')).toBe(baseline);
    });
    test('failed mounting rolls back archive, rules and string overlays', () => {
        const rules = Engine.rules;
        const strings = new Strings({ 'Name:Original': 'Original' });
        const sound = { beginSpecsOverlay() { throw new Error('sound parser failure'); } };
        Engine.iniFiles.set(Engine.getFileNameVariant('sound.ini'), new IniFile('[Defaults]\nVolume=60'));
        expect(() => mountSessionContent(new Map([[Engine.getFileNameVariant('sound.ini'), encode('[HostSound]\nSounds=custom')]]), { strings, sound: sound as any })).toThrow('sound parser failure');
        expect(Engine.rules).toBe(rules);
        expect(Engine.vfs!.hasArchive('multiplayer-session-content')).toBe(false);
        expect(strings.get('Name:Original')).toBe('Original');
        expect(hasSessionContent()).toBe(false);
    });
    test('switching packages starts from retail state, not previous session patches', () => {
        const first = mountSessionContent(new Map([['rulescd.ini', encode('[FIRST]\nCost=100')]]));
        mountSessionContent(new Map([['rulescd.ini', encode('[SECOND]\nCost=200')]]));
        first.dispose();
        expect(Engine.rules!.getSection('FIRST')).toBeUndefined();
        expect(Engine.rules!.getSection('SECOND')!.getNumber('Cost')).toBe(200);
        expect(hasSessionContent()).toBe(true);
    });
    test('missing new unit art is rejected before Ready and restores retail state', () => {
        const rules = Engine.rules;
        expect(() => mountSessionContent(new Map([['rulescd.ini', encode('[VehicleTypes]\n99=MISSING\n[MISSING]\nCost=100')]]))).toThrow('Missing session resource missing.shp');
        expect(Engine.rules).toBe(rules);
        expect(hasSessionContent()).toBe(false);
    });
    test('invalid paths fail before modifying any engine state', () => {
        const rules = Engine.rules;
        expect(() => mountSessionContent(new Map([['../rulescd.ini', encode('bad')]]))).toThrow('Invalid session filename');
        expect(Engine.rules).toBe(rules);
        expect(Engine.vfs!.hasArchive('multiplayer-session-content')).toBe(false);
    });
    test('string overlay removes new labels and restores replacements', () => {
        const strings = new Strings({ 'Name:Unit': 'Retail' });
        const restore = strings.beginOverlay({ 'Name:Unit': 'Host', 'Name:Custom': 'Custom %hs' });
        expect(strings.get('NAME:UNIT')).toBe('Host');
        expect(strings.get('Name:Custom', 'Tank')).toBe('Custom Tank');
        restore();
        restore();
        expect(strings.get('Name:Unit')).toBe('Retail');
        expect(strings.has('Name:Custom')).toBe(false);
    });
});
