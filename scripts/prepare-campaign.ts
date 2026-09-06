/** Import and audit supported Allied missions from the user's retail archives. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MixFile } from '../redalert2/src/data/MixFile';
import { VirtualFile } from '../redalert2/src/data/vfs/VirtualFile';
import { IniFile } from '../redalert2/src/data/IniFile';
import { CampaignScenario } from '../redalert2/src/data/campaign/CampaignScenario';
import { campaignMissions } from '../redalert2/src/data/campaign/CampaignMissions';
import { resolveCampaignMovie } from '../redalert2/src/data/campaign/CampaignMovies';

const retail = process.argv[2] ?? process.env.RA2_RETAIL_DIR;
if (!retail || process.argv.length > 3) {
    console.error('Usage: bun scripts/prepare-campaign.ts "/path/to/retail/install"');
    process.exit(1);
}
const archiveName = readdirSync(retail).find(name => name.toLowerCase() === 'maps01.mix');
if (!archiveName) throw new Error(`MAPS01.MIX not found in ${retail}`);
const archive = new MixFile(VirtualFile.fromBytes(new Uint8Array(readFileSync(join(retail, archiveName))), archiveName).stream);
for (const mission of campaignMissions) {
    const map = archive.openFile(mission.map);
    const stream = map.stream;
    const bytes = new Uint8Array(stream.buffer, stream.byteOffset, stream.byteLength);
    const scenario = new CampaignScenario(new IniFile(map.readAsString()));
    const audit = scenario.audit();
    const output = join(import.meta.dir, `../campaign-export/ra2/${mission.id}`);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, mission.map), bytes);
    writeFileSync(join(output, 'audit.json'), JSON.stringify(audit, null, 2));
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, mission: mission.id, map: mission.map, title: mission.title,
        playerHouse: scenario.playerHouse.id, briefing: scenario.basic.Briefing, next: mission.next,
        carryOver: {money: Number(scenario.basic.CarryOverMoney), cap: Number(scenario.basic.CarryOverCap), timer: scenario.basic.TimerInherit === 'yes'},
        engine: 'ra2', status: 'development',
        files: [{ path: mission.map, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }],
    }, null, 2));
    console.log(`Imported ${mission.title} to ${output}`);
    console.log(JSON.stringify(audit.counts));
    console.log(`Unsupported action types: ${audit.unsupportedActions.map(entry => entry.type).join(', ')}`);
    console.log(`Unsupported event types: ${audit.unsupportedEvents.map(entry => entry.type).join(', ')}`);
    console.log(`Reference errors: ${audit.referenceErrors.length}`);
    console.log('Experimental campaign package; see docs/CAMPAIGN_AGENT_GUIDE.md for tested coverage.');

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
    const clips = new Map<string,string>();
    for (const key of ['Intro','Brief','Win','Lose','PostScore','PreMapSelect']) {
        const name = scenario.basic[key];
        if (name && name.toLowerCase() !== '<none>') clips.set(key.toLowerCase(), name);
    }
    for (const trigger of scenario.triggers) for (const action of trigger.actions) {
        if (action.type === 100) {
            if (!art) throw new Error('Missing retail art.ini');
            const movie = resolveCampaignMovie(art, Number(action.params[1]));
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
}
