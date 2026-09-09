import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const inputs = ['src', 'server', 'package.json', 'bun.lock', 'vite.config.ts', 'buildVersion.ts'];

/** A failed fingerprint must never produce a playable, ambiguously versioned build. */
export function computeBuildVersion(root: string): string {
    let revision: string;
    try {
        revision = execFileSync('git', ['describe', '--tags', '--always'], {
            cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (!revision) throw new Error('Git returned an empty revision.');
    } catch (error) {
        throw new Error(`Cannot determine the multiplayer Git revision in ${root}. `
            + 'Install Git, reopen your terminal, and build from a Git clone (not a downloaded ZIP). '
            + 'Run "git describe --tags --always" from redalert2 to diagnose checkout or ownership errors. '
            + `Original error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const hash = createHash('sha256');
    const add = (relative: string): void => {
        const fullPath = path.join(root, relative);
        try {
            if (fs.statSync(fullPath).isDirectory()) {
                for (const name of fs.readdirSync(fullPath).sort()) add(`${relative}/${name}`);
            } else {
                hash.update(relative + '\0');
                hash.update(fs.readFileSync(fullPath));
                hash.update('\0');
            }
        } catch (error) {
            throw new Error(`Cannot fingerprint multiplayer input ${fullPath}: `
                + (error instanceof Error ? error.message : String(error)), { cause: error });
        }
    };
    for (const input of inputs) add(input);
    return `${revision}-${hash.digest('hex').slice(0, 12)}`;
}

/** Prevent a native package from silently reusing stale or unversioned web output. */
export function verifyBuiltVersion(root: string): string {
    const expected = computeBuildVersion(root);
    let actual: unknown;
    try { actual = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-version.json'), 'utf8')).version; }
    catch {
        throw new Error('Web build version metadata is missing or invalid. Rebuild without --no-web / -NoWeb.');
    }
    if (actual !== expected) {
        throw new Error(`Web build version ${String(actual)} does not match this checkout (${expected}). Rebuild without --no-web / -NoWeb.`);
    }
    return expected;
}
