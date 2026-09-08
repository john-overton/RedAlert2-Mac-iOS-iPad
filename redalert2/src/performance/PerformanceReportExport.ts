/** Native shells own the destination; the web page never supplies a filesystem path. */
export async function savePerformanceReport(json: string): Promise<string> {
    const shell = window.__RA2_SHELL__;
    if (shell) {
        if (!shell.savePerformanceReport) {
            throw new Error('This app version does not support saving reports. Rebuild or update the native app.');
        }
        const result = await shell.savePerformanceReport(json);
        if (!result || typeof result.path !== 'string' || !result.path) {
            throw new Error('The app did not confirm a saved report location.');
        }
        return `Saved to ${result.path}`;
    }

    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ra2-slowdown-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(anchor);
    try { anchor.click(); }
    finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return 'Report download requested. Check your browser downloads.';
}
