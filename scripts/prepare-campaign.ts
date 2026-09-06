/** Import and audit Allied RA2 mission one from the user's retail MAPS01.MIX. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MixFile } from '../redalert2/src/data/MixFile';
import { VirtualFile } from '../redalert2/src/data/vfs/VirtualFile';
import { IniFile } from '../redalert2/src/data/IniFile';
import { CampaignScenario } from '../redalert2/src/data/campaign/CampaignScenario';

const retail = process.argv[2] ?? process.env.RA2_RETAIL_DIR;
if (!retail || process.argv.length > 3) {
    console.error('Usage: bun scripts/prepare-campaign.ts "/path/to/retail/install"');
    process.exit(1);
}
const archiveName = readdirSync(retail).find(name => name.toLowerCase() === 'maps01.mix');
if (!archiveName) throw new Error(`MAPS01.MIX not found in ${retail}`);
const archive = new MixFile(VirtualFile.fromBytes(new Uint8Array(readFileSync(join(retail, archiveName))), archiveName).stream);
const map = archive.openFile('all01t.map');
const stream = map.stream;
const bytes = new Uint8Array(stream.buffer, stream.byteOffset, stream.byteLength);
const scenario = new CampaignScenario(new IniFile(map.readAsString()));
const audit = scenario.audit();
const output = join(import.meta.dir, '../campaign-export/ra2/allied-01');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'all01t.map'), bytes);
writeFileSync(join(output, 'audit.json'), JSON.stringify(audit, null, 2));
writeFileSync(join(output, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, mission: 'allied-01', engine: 'ra2', status: 'development',
    files: [{ path: 'all01t.map', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }],
}, null, 2));
console.log(`Imported Allied mission one to ${output}`);
console.log(JSON.stringify(audit.counts));
console.log(`Unsupported action types: ${audit.unsupportedActions.map(entry => entry.type).join(', ')}`);
console.log(`Unsupported event types: ${audit.unsupportedEvents.map(entry => entry.type).join(', ')}`);
console.log(`Reference errors: ${audit.referenceErrors.length}`);
console.log('Experimental mission-one package; see docs/CAMPAIGN_MISSION_ONE.md for tested coverage.');

// Campaign clips live on both retail discs. Convert only the movies referenced
// by this mission, plus its briefing, into browser-native H.264/AAC files.
const { spawnSync } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const findRetail = (name: string) => readdirSync(retail).find(file => file.toLowerCase() === name.toLowerCase());
const openMix = (name: string) => {
    const file = findRetail(name);
    return file ? new MixFile(VirtualFile.fromBytes(new Uint8Array(readFileSync(join(retail,file))),file).stream) : undefined;
};
const baseMix = openMix('ra2.mix');
const localMix = baseMix ? new MixFile(baseMix.openFile('local.mix').stream) : undefined;
const art = localMix ? new IniFile(localMix.openFile('art.ini').readAsString()) : undefined;
const clips = new Map<string,string>([['intro',scenario.basic.Intro]]);
for (const trigger of scenario.triggers) for (const action of trigger.actions) {
    if (action.type === 100) {
        const movie = art?.getSection('Movies')?.getString(action.params[1]);
        if (!movie) throw new Error(`Missing retail movie index ${action.params[1]}`);
        clips.set(`movie-${action.params[1]}`,movie);
    }
}
const mediaArchives = [openMix('movies01.mix'),openMix('movies02.mix')].filter(Boolean);
const manifest = JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));
manifest.media = [];
for (const [alias,name] of clips) {
    const filename = `${name}.bik`;
    const mix = mediaArchives.find(archive => archive!.containsFile(filename));
    if (!mix) { console.warn(`Optional campaign movie missing: ${filename}`); continue; }
    const source = mix!.openFile(filename).getBytes();
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const target = join(output,`${alias}.mp4`);
    const stamp = join(output,`${alias}.sha256`);
    if (!existsSync(target) || !existsSync(stamp) || readFileSync(stamp,'utf8') !== sourceHash) {
        const sourceFile = join(output,`${alias}.bik`);
        writeFileSync(sourceFile,source);
        const converted = spawnSync('ffmpeg',['-v','error','-y','-i',sourceFile,'-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',target],{stdio:'inherit'});
        const { unlinkSync } = await import('node:fs');
        unlinkSync(sourceFile);
        if (converted.status !== 0) throw new Error('Campaign movie conversion requires ffmpeg with libx264');
        writeFileSync(stamp,sourceHash);
    }
    const data=readFileSync(target);
    manifest.files.push({path:`${alias}.mp4`,size:data.length,sha256:createHash('sha256').update(data).digest('hex')});
    manifest.media.push({alias,source:filename,sourceSha256:sourceHash});
}
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(`Prepared ${manifest.media.length} campaign movies.`);
