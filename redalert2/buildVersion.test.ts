import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeBuildVersion, verifyBuiltVersion } from './buildVersion';

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(git = true): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'ra2-build-version-'));
    fixtures.push(dir);
    mkdirSync(path.join(dir, 'src'));
    mkdirSync(path.join(dir, 'server'));
    for (const file of ['package.json', 'bun.lock', 'vite.config.ts', 'buildVersion.ts']) writeFileSync(path.join(dir, file), '{}\n');
    if (git) {
        const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
        run(['init']);
        run(['add', '.']);
        run(['-c', 'user.name=Version Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
            'commit', '-m', 'Fixture']);
    }
    return dir;
}

test('fingerprint is deterministic and includes untracked source, lockfile and fingerprint implementation', () => {
    const dir = fixture();
    const first = computeBuildVersion(dir);
    expect(first).toMatch(/^[0-9a-f]+-[0-9a-f]{12}$/);
    expect(computeBuildVersion(dir)).toBe(first);
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const value = 1;');
    const sourceChanged = computeBuildVersion(dir);
    expect(sourceChanged).not.toBe(first);
    writeFileSync(path.join(dir, 'bun.lock'), 'changed');
    const lockChanged = computeBuildVersion(dir);
    expect(lockChanged).not.toBe(sourceChanged);
    writeFileSync(path.join(dir, 'buildVersion.ts'), 'changed');
    expect(computeBuildVersion(dir)).not.toBe(lockChanged);
});

test('missing Git checkout fails with actionable diagnostics instead of development fallback', () => {
    expect(() => computeBuildVersion(fixture(false))).toThrow('build from a Git clone');
});

test('missing hash input identifies the file rather than silently hiding an I/O error', () => {
    const dir = fixture();
    rmSync(path.join(dir, 'bun.lock'));
    expect(() => computeBuildVersion(dir)).toThrow('bun.lock');
});

test('packaging refuses missing, development and stale manifests; accepts matching web build', () => {
    const dir = fixture();
    expect(() => verifyBuiltVersion(dir)).toThrow('Rebuild without');
    mkdirSync(path.join(dir, 'dist'));
    const manifest = path.join(dir, 'dist', 'build-version.json');
    writeFileSync(manifest, JSON.stringify({ version: 'development' }));
    expect(() => verifyBuiltVersion(dir)).toThrow('does not match');
    const version = computeBuildVersion(dir);
    writeFileSync(manifest, JSON.stringify({ version }));
    expect(verifyBuiltVersion(dir)).toBe(version);
    writeFileSync(path.join(dir, 'src', 'changed.ts'), 'changed');
    expect(() => verifyBuiltVersion(dir)).toThrow('does not match');
});
