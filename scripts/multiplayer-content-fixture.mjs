// Generate local-only fixtures from the player's installed map and tank INIs.
// No retail map or artwork is checked in. The cameo pixels below are original.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const customUnitName = 'SMOKETNK';
export const customMapName = 'host-content-smoke.map';
export const customCameoName = 'smokeico.shp';
export function createContentFixture(directory, { map, tankRules }) {
    mkdirSync(directory, { recursive: true });
    const rules = tankRules.replace(/^\[MTNK\]/m, `[${customUnitName}]`)
        + '\nName=Host Content Tank\nUIName=NOSTR:Host Content Tank\nImage=MTNK\nStrength=777\nCost=1\nTechLevel=1\nPrerequisite=\nRequiredHouses=\nForbiddenHouses=\nOwner=British,French,Germans,Americans,Alliance,Russians,Confederation,Africans,Arabs,YuriCountry\nAllowedToStartInMultiplayer=no\n';
    const files = {
        [customMapName]: map + '\n[Basic]\nName=Host Content Smoke\n',
        'rulescd.ini': `[VehicleTypes]\n9000=${customUnitName}\n\n${rules}\n`,
        'artcd.ini': '[MTNK]\nCameo=SMOKEICO\nAltCameo=SMOKEICO\n',
        [customCameoName]: makeCameo(),
    };
    return Object.entries(files).map(([name, data]) => {
        const path = resolve(directory, name); writeFileSync(path, data); return path;
    });
}
function makeCameo() {
    const width = 60, height = 48;
    const bytes = Buffer.alloc(32 + width * height);
    bytes.writeUInt16LE(width, 2); bytes.writeUInt16LE(height, 4); bytes.writeUInt16LE(1, 6);
    bytes.writeUInt16LE(width, 12); bytes.writeUInt16LE(height, 14);
    bytes[16] = 1; bytes.writeUInt32LE(32, 28);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const border = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
        const tread = y >= 26 && y <= 34 && x >= 10 && x <= 48;
        const body = y >= 19 && y <= 28 && x >= 15 && x <= 43;
        const turret = y >= 13 && y <= 21 && x >= 24 && x <= 34;
        const barrel = y >= 15 && y <= 17 && x >= 33 && x <= 51;
        bytes[32 + y * width + x] = border ? 200 : tread ? 12 : body || turret || barrel ? 150 : 1;
    }
    return bytes;
}
