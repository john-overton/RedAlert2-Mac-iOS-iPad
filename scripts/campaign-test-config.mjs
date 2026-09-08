import { readFileSync } from 'node:fs';

// Exercise the same campaign checks with either engine; keep classic coverage.
export function campaignTestConfig() {
    const engine = process.env.RA2_CAMPAIGN_ENGINE ?? 'ra2';
    if (!['ra2', 'yr'].includes(engine)) throw new Error('RA2_CAMPAIGN_ENGINE must be ra2 or yr');
    console.log(`Campaign test engine: ${engine}`);
    const config = readFileSync(new URL('../redalert2/public/config.ini', import.meta.url), 'utf8');
    return config.replace(/^engine = .*$/m, `engine = ${engine}`)
        .replace(/^csfFile = .*$/m, `csfFile = ${engine === 'yr' ? 'generalmd.csf' : 'general.csf'}`);
}
