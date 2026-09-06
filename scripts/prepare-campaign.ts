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
console.log('Development import only. Campaign launch and runtime support are not implemented yet.');
