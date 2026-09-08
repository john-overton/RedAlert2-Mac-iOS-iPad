import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const buildVersion = (() => {
    try {
        const revision = execFileSync('git', ['describe', '--tags', '--always'], { cwd: __dirname, encoding: 'utf8' }).trim();
        // A plain "-dirty" would allow different local implementations to join.
        // Include source contents (also untracked new modules) in the wire version.
        const hash = createHash('sha256');
        const add = (relative: string) => {
            const fullPath = path.join(__dirname, relative);
            if (fs.statSync(fullPath).isDirectory()) {
                for (const name of fs.readdirSync(fullPath).sort()) add(`${relative}/${name}`);
            } else { hash.update(relative + '\0'); hash.update(fs.readFileSync(fullPath)); hash.update('\0'); }
        };
        for (const entry of ['src', 'server', 'package.json', 'bun.lock', 'vite.config.ts']) add(entry);
        return `${revision}-${hash.digest('hex').slice(0, 12)}`;
    }
    catch { return process.env.RA2_BUILD_VERSION || 'development'; }
})();
const devPort = 4000;
// Mirrors the iOS shell's ra2app://app/gameres/ mount so the ?shell code path
// (first-launch asset seeding) is testable in a desktop browser.
const gameResDir = path.resolve(__dirname, '../gameres-export');
const serveGameResDev = (): Plugin => ({
    name: 'serve-gameres-dev',
    configureServer(server) {
        server.middlewares.use('/gameres', (req, res, next) => {
            const relPath = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
            const filePath = path.join(gameResDir, relPath);
            if (!filePath.startsWith(gameResDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                next();
                return;
            }
            res.setHeader('Content-Type', filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream');
            res.setHeader('Content-Length', fs.statSync(filePath).size);
            fs.createReadStream(filePath).pipe(res);
        });
    },
});
const serveCampaignDev = (): Plugin => ({
    name: 'serve-local-campaign-dev',
    configureServer(server) {
        const root = path.resolve(__dirname, '../campaign-export');
        server.middlewares.use('/campaign', (req, res, next) => {
            let relative: string;
            try { relative = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, ''); }
            catch { res.statusCode = 400; res.end(); return; }
            const file = path.resolve(root, relative);
            if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                res.statusCode = 404; res.end(); return;
            }
            res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : file.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream');
            res.setHeader('Content-Length', fs.statSync(file).size);
            fs.createReadStream(file).pipe(res);
        });
    },
});
const manualHttpsConfig = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt')
    ? { key: fs.readFileSync('./certs/server.key'), cert: fs.readFileSync('./certs/server.crt') }
    : undefined;
// http://localhost is still a secure context, so SharedArrayBuffer keeps working
// with the COOP/COEP headers below. Used for embedded-browser dev and the iOS shell.
const useHttp = !!process.env.RA2_HTTP;
export default defineConfig({
    define: { __RA2_BUILD_VERSION__: JSON.stringify(buildVersion) },
    plugins: [react(), serveGameResDev(), serveCampaignDev(), ...(manualHttpsConfig || useHttp ? [] : [basicSsl()])],
    server: {
        host: '0.0.0.0',
        port: devPort,
        strictPort: true,
        https: useHttp ? undefined : (manualHttpsConfig ?? {}),
        headers: {
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
        },
        fs: {
            allow: ['..']
        }
    },
    preview: {
        host: '0.0.0.0',
        port: devPort,
        strictPort: true,
    },
    resolve: {
        alias: {
            '@': '/src'
        }
    },
    optimizeDeps: {
        exclude: ['7z-wasm', '@ffmpeg/ffmpeg'],
        include: []
    },
    worker: {
        format: 'es'
    },
    assetsInclude: ['**/*.wasm']
});
