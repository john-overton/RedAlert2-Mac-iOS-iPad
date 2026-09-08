// Bundle ws and the pure server core into the Electron app; no runtime install needed.
import { fileURLToPath } from 'node:url';

const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./electron.ts', import.meta.url))],
    outdir: fileURLToPath(new URL('../dist-server', import.meta.url)),
    naming: 'multiplayer.cjs', target: 'node', format: 'cjs',
    external: ['bufferutil', 'utf-8-validate'],
});
if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}
