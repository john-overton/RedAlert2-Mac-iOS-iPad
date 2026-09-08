import { Engine } from '../../engine/Engine';
import { IniFile } from '../../data/IniFile';
import { CsfFile } from '../../data/CsfFile';
import type { Strings } from '../../data/Strings';
import { VirtualFile } from '../../data/vfs/VirtualFile';
import type { Sound } from '../../engine/sound/Sound';
import { SoundSpecs } from '../../engine/sound/SoundSpecs';

const archiveName = 'multiplayer-session-content';
let active: SessionContentResources | undefined;

export interface SessionContentOptions {
    strings?: Strings;
    sound?: Sound;
}

/** Mount only a fully downloaded and hash-verified package. No imported files are written. */
export function mountSessionContent(files: ReadonlyMap<string, Uint8Array>, options: SessionContentOptions = {}): SessionContentResources {
    restoreSessionContent();
    const resources = new SessionContentResources(files, options);
    resources.mount();
    active = resources;
    return resources;
}

export function restoreSessionContent(): void {
    active?.dispose();
    active = undefined;
}

export function hasSessionContent(): boolean {
    return active !== undefined;
}

export class SessionContentResources {
    private cleanups: (() => void)[] = [];
    private mounted = false;
    constructor(private files: ReadonlyMap<string, Uint8Array>, private options: SessionContentOptions = {}) {}

    mount(): void {
        if (this.mounted) throw new Error('Session content is already mounted');
        const vfs = Engine.vfs;
        if (!vfs || !Engine.rules || !Engine.art || !Engine.ai) throw new Error('Load retail game resources before mounting session content');
        if (vfs.hasArchive(archiveName)) throw new Error('Another session content package is mounted');

        // Parse before changing the engine. INI packages are patches, so a small unit
        // definition does not remove the retail definitions or engine compatibility fixes.
        const bytes = new Map<string, Uint8Array>();
        const iniPatches = new Map<string, IniFile>();
        const labels: Record<string, string> = Object.create(null);
        for (const [filename, data] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
            if (!/^[a-z0-9][a-z0-9_.-]*$/.test(filename) || filename.includes('..')) throw new Error(`Invalid session filename: ${filename}`);
            const file = VirtualFile.fromBytes(data.slice(), filename);
            if (filename.endsWith('.ini')) {
                const patch = new IniFile(file);
                iniPatches.set(filename, patch);
                const baseline = Engine.iniFiles.has(filename) ? Engine.iniFiles.get(filename) : undefined;
                const merged = baseline ? baseline.clone().mergeWith(patch) : patch;
                bytes.set(filename, new TextEncoder().encode(merged.toString()));
            } else {
                bytes.set(filename, data.slice());
                if (filename.endsWith('.csf')) Object.assign(labels, new CsfFile(file).data);
            }
        }
        const rules = Engine.rules;
        const art = Engine.art;
        const ai = Engine.ai;
        const theaters = Engine.theaters;
        const activeTheater = Engine.activeTheater;
        const mergePatches = (baseline: IniFile, names: string[]) => {
            const result = baseline.clone();
            for (const name of [...new Set(names)]) {
                const patch = iniPatches.get(name);
                if (patch) result.mergeWith(patch);
            }
            return result;
        };
        this.mounted = true;
        try {
            vfs.addArchive({
                containsFile: name => bytes.has(name.toLowerCase()),
                // Parsers own their stream cursor; do not share streams between loads.
                openFile: name => {
                    const data = bytes.get(name.toLowerCase());
                    if (!data) throw new Error(`Missing session resource ${name}`);
                    return VirtualFile.fromBytes(data, name.toLowerCase());
                },
            }, archiveName, true);
            this.cleanups.push(() => vfs.removeArchive(archiveName));
            const names = new Set(bytes.keys());
            for (const collection of [Engine.iniFiles, Engine.images, Engine.voxels, Engine.voxelAnims, Engine.palettes, Engine.tileData, Engine.sounds]) {
                this.cleanups.push(collection.beginOverlay(names));
            }
            this.cleanups.push(() => {
                Engine.rules = rules;
                Engine.art = art;
                Engine.ai = ai;
                Engine.theaters = theaters;
                Engine.activeTheater = activeTheater;
            });
            Engine.rules = mergePatches(rules, ['rules.ini', Engine.getFileNameVariant('rules.ini'), Engine.customRulesFileName]);
            Engine.art = mergePatches(art, ['art.ini', Engine.getFileNameVariant('art.ini'), Engine.customArtFileName]);
            Engine.ai = mergePatches(ai, ['ai.ini', Engine.getFileNameVariant('ai.ini')]);
            this.validateUnitAssets(rules, iniPatches);
            Engine.theaters = new Map();
            Engine.activeTheater = undefined;
            if (this.options.strings) this.cleanups.push(this.options.strings.beginOverlay(labels));
            const soundFilename = Engine.getFileNameVariant('sound.ini');
            if (this.options.sound && iniPatches.has(soundFilename)) {
                this.cleanups.push(this.options.sound.beginSpecsOverlay(new SoundSpecs(Engine.getIni(soundFilename))));
            }
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    private validateUnitAssets(baselineRules: IniFile, patches: ReadonlyMap<string, IniFile>): void {
        const requireFile = (filename: string, owner: string) => {
            if (!Engine.vfs!.fileExists(filename.toLowerCase())) throw new Error(`Missing session resource ${filename} required by ${owner}`);
        };
        // Theater-dependent building art is resolved during map loading. Mobile
        // units and explicit cameos have stable filenames and can fail before Ready.
        for (const type of ['VehicleTypes', 'InfantryTypes', 'AircraftTypes']) {
            for (const name of Engine.rules!.getSection(type)?.entries.values() ?? []) {
                if (typeof name !== 'string') continue;
                const rule = Engine.rules!.getSection(name);
                if (!rule) continue;
                const baseline = baselineRules.getSection(name);
                const image = rule.getString('Image') || name;
                if (baseline && (baseline.getString('Image') || name) === image) continue;
                const art = Engine.art!.getSection(image);
                const filename = (art?.getString('Image') || image).toLowerCase();
                if (art?.getBool('Voxel')) {
                    requireFile(filename + '.vxl', name);
                    requireFile(filename + '.hva', name);
                } else if (!art?.getBool('Theater')) {
                    requireFile(filename + '.shp', name);
                }
            }
        }
        for (const name of ['art.ini', Engine.getFileNameVariant('art.ini'), Engine.customArtFileName]) {
            for (const section of patches.get(name)?.getOrderedSections() ?? []) {
                for (const key of ['Cameo', 'AltCameo']) {
                    const image = section.getString(key);
                    if (image && image.toLowerCase() !== 'xxicon') requireFile(image.toLowerCase() + '.shp', section.name);
                }
            }
        }
    }

    dispose(): void {
        if (!this.mounted) return;
        this.mounted = false;
        for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
        if (active === this) active = undefined;
    }
}
