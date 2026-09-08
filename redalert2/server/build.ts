// Bundle ws and the pure server core into the Electron app; no runtime install needed.
const result = await Bun.build({
    entrypoints: [new URL('./electron.ts', import.meta.url).pathname],
    outdir: new URL('../dist-server', import.meta.url).pathname,
    naming: 'multiplayer.cjs', target: 'node', format: 'cjs',
    external: ['bufferutil', 'utf-8-validate'],
});
if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}
