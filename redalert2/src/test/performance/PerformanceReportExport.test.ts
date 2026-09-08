import { afterEach, expect, test } from 'bun:test';
import { savePerformanceReport } from '@/performance/PerformanceReportExport';

const originalWindow = globalThis.window;
afterEach(() => { globalThis.window = originalWindow; });

test('native export passes JSON to the shell and reports the confirmed path', async () => {
    const calls: string[] = [];
    globalThis.window = { __RA2_SHELL__: { platform: 'macos', version: 'test',
        savePerformanceReport: async (json: string) => {
            calls.push(json);
            return { path: '/Games/performance_logs/report.json' };
        },
    } } as unknown as Window & typeof globalThis;
    expect(await savePerformanceReport('{"enabled":true}')).toBe('Saved to /Games/performance_logs/report.json');
    expect(calls).toEqual(['{"enabled":true}']);
});

test('native errors and older shells do not silently fall back to blocked browser downloads', async () => {
    globalThis.window = { __RA2_SHELL__: { platform: 'macos', version: 'test' } } as unknown as Window & typeof globalThis;
    await expect(savePerformanceReport('{}')).rejects.toThrow('Rebuild or update');
    window.__RA2_SHELL__!.savePerformanceReport = async () => { throw new Error('Folder is read-only'); };
    await expect(savePerformanceReport('{}')).rejects.toThrow('Folder is read-only');
    window.__RA2_SHELL__!.savePerformanceReport = async () => ({ path: '' });
    await expect(savePerformanceReport('{}')).rejects.toThrow('did not confirm');
});
