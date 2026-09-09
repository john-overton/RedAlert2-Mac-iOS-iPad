// bun scripts/build-windows.ts [--ra2] [--no-web] [--no-campaign] [--arch x64|arm64]
// Portable Windows folder; runs on Windows, macOS and Linux. No Wine required.
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from '../windows/electron-runtime.json';
import { verifyBuiltVersion } from '../redalert2/buildVersion';

const root = fileURLToPath(new URL('../', import.meta.url));
let variant = 'yr', arch: keyof typeof runtime.sha256 = 'x64', skipWeb = false, campaign = true;
for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--ra2') variant = 'ra2';
    else if (arg === '--no-web') skipWeb = true;
    else if (arg === '--no-campaign') campaign = false;
    else if (arg === '--arch' && ['x64', 'arm64'].includes(process.argv[i + 1])) arch = process.argv[++i] as typeof arch;
    else if (arg === '--help') {
        console.log('bun scripts/build-windows.ts [--ra2] [--no-web] [--no-campaign] [--arch x64|arm64]');
        process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
async function required(relative: string) {
    if (!(await Bun.file(path.join(root, relative)).exists()) || !(await stat(path.join(root, relative))).size)
        throw new Error(`Missing ${relative}. Run scripts/setup-windows.ps1 with your retail install first (scripts/setup.sh on Mac/Linux).`);
}
async function run(args: string[], cwd = root, env = process.env) {
    const child = Bun.spawn(args, { cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    const code = await child.exited;
    if (code) throw new Error(`${args[0]} failed with exit code ${code}`);
}
async function sha256(file: string) {
    const hash = createHash('sha256');
    for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
    return hash.digest('hex');
}
async function getRuntime() {
    const name = `electron-v${runtime.version}-win32-${arch}.zip`;
    const cache = path.join(root, 'build', 'windows', 'cache');
    await mkdir(cache, { recursive: true });
    const archive = path.join(cache, name);
    if (await Bun.file(archive).exists() && await sha256(archive) === runtime.sha256[arch]) return archive;
    console.log(`Downloading ${name}`);
    const response = await fetch(`https://github.com/electron/electron/releases/download/v${runtime.version}/${name}`);
    if (!response.ok) throw new Error(`Electron download failed: ${response.status}`);
    const partial = `${archive}.${process.pid}.part`;
    try {
        await Bun.write(partial, response);
        if (await sha256(partial) !== runtime.sha256[arch]) throw new Error('Electron checksum mismatch; refusing to package it.');
        await rm(archive, { force: true });
        await rename(partial, archive);
    } finally { await rm(partial, { force: true }); }
    return archive;
}
async function manifest(dir: string, prefix = ''): Promise<{path: string; size: number}[]> {
    const result: {path: string; size: number}[] = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : 1)) {
        if (entry.name === '.DS_Store' || entry.name === 'manifest.json') continue;
        const relative = prefix + entry.name, full = path.join(dir, entry.name);
        if (entry.isDirectory()) result.push(...await manifest(full, relative + '/'));
        else if (entry.isFile()) result.push({ path: relative, size: (await stat(full)).size });
    }
    return result;
}
const cleanFilter = (source: string) => !['.DS_Store', 'local-pack'].includes(path.basename(source));
for (const file of ['redalert2/public/general.csf', 'gameres-export/ra2.mix']) await required(file);
if (variant === 'yr') for (const file of ['redalert2/public/generalmd.csf', 'gameres-export/ra2md.mix']) await required(file);
if (!skipWeb) await run([process.execPath, 'run', 'build'], path.join(root, 'redalert2'));
await required('redalert2/dist/index.html');
const multiplayerVersion = verifyBuiltVersion(path.join(root, 'redalert2'));
console.log(`Packaging multiplayer version: ${multiplayerVersion}`);
await run([process.execPath, 'run', 'build:server'], path.join(root, 'redalert2'));
const archive = await getRuntime();
const parent = path.join(root, 'build', 'windows', arch);
const out = path.join(parent, variant), stage = path.join(parent, `${variant}.staging-${process.pid}`);
await mkdir(stage, { recursive: true });
try {
    if (process.platform === 'win32') {
        // Environment values avoid PowerShell interpolation of paths containing spaces/quotes.
        await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
            "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:RA2_ARCHIVE -DestinationPath $env:RA2_STAGE -Force"], root,
            { ...process.env, RA2_ARCHIVE: archive, RA2_STAGE: stage });
    } else await run(['unzip', '-q', archive, '-d', stage]);
    const resources = path.join(stage, 'resources', 'Resources');
    const app = path.join(stage, 'resources', 'app');
    await mkdir(app, { recursive: true });
    await mkdir(resources, { recursive: true });
    await rm(path.join(stage, 'resources', 'default_app.asar'), { force: true });
    for (const name of ['main.js', 'preload.js']) await cp(path.join(root, 'linux', name), path.join(app, name));
    await cp(path.join(root, 'redalert2/dist-server/multiplayer.cjs'), path.join(app, 'multiplayer.cjs'));
    await cp(path.join(root, 'redalert2/node_modules/ws/LICENSE'), path.join(app, 'ws-LICENSE'));
    for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) await cp(path.join(root, name), path.join(app, name));
    const title = variant === 'yr' ? "Yuri's Revenge" : 'Red Alert 2';
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: `ra2-${variant}`, version: '0.1.0', main: 'main.js', private: true }, null, 2));
    await writeFile(path.join(app, 'app.json'), JSON.stringify({ name: title, variant, version: '0.1.0' }, null, 2));
    await cp(path.join(root, 'redalert2/dist'), path.join(resources, 'WebDist'), { recursive: true, filter: cleanFilter });
    const config = path.join(resources, 'WebDist/config.ini');
    if (variant === 'ra2') await writeFile(config, (await Bun.file(config).text()).replace(/^engine = yr$/m, 'engine = ra2').replace(/^csfFile = generalmd.csf$/m, 'csfFile = general.csf'));
    const campaignSource = path.join(root, 'campaign-export/ra2');
    const hasCampaign = campaign && await Bun.file(path.join(campaignSource, 'allied-01/all01t.map')).exists() && await Bun.file(path.join(campaignSource, 'allied-02/all02s.map')).exists();
    if (hasCampaign) await cp(campaignSource, path.join(resources, 'WebDist/campaign/ra2'), { recursive: true,
        filter: source => cleanFilter(source) && !/(audit\.json|result\.json|\.sha256)$/.test(source) });
    await cp(path.join(root, 'gameres-export'), path.join(resources, 'GameRes'), { recursive: true, filter: cleanFilter });
    await writeFile(path.join(resources, 'GameRes/manifest.json'), JSON.stringify({ files: await manifest(path.join(resources, 'GameRes')) }));
    await cp(path.join(root, 'ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png'), path.join(resources, 'icon.png'));
    await rename(path.join(stage, 'electron.exe'), path.join(stage, 'Red Alert 2.exe'));
    await writeFile(path.join(stage, 'BUILD-INFO.json'), JSON.stringify({ variant, arch, multiplayerVersion, electron: runtime.version, electronSha256: runtime.sha256[arch], campaign: hasCampaign }, null, 2));
    await writeFile(path.join(stage, 'README.txt'), `Launch Red Alert 2.exe. Keep this entire folder together.\r\nVariant: ${title}; Windows ${arch}; Electron ${runtime.version}.\r\nF11 toggles fullscreen. Multiplayer hosting uses the selected TCP port.\r\nThis local build contains imported retail assets; do not publish it.\r\nWindows runtime acceptance is still required; see docs/WINDOWS.md in the source repository.\r\n`);
    // Keep the previous build until staging succeeds; a running app may lock the old folder.
    const previous = `${out}.previous`;
    await rm(previous, { recursive: true, force: true });
    let moved = false;
    try { await rename(out, previous); moved = true; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, out); } catch (error) { if (moved) await rename(previous, out); throw error; }
    await rm(previous, { recursive: true, force: true });
    console.log(`Built: ${path.join(out, 'Red Alert 2.exe')}\nCampaign: ${hasCampaign ? 'included' : 'not included'}`);
} finally { await rm(stage, { recursive: true, force: true }); }
