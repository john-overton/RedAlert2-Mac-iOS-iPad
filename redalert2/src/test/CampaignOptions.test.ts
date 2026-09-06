import { expect, test } from 'bun:test';
import { GeneralOptions } from '../gui/screen/options/GeneralOptions';
import { campaignSpeedFactor } from '../game/campaign/CampaignSpeed';
import { GameSpeed } from '../game/GameSpeed';
import { IniFile } from '../data/IniFile';
import { resolveCampaignMovie } from '../data/campaign/CampaignMovies';

test('campaign defaults to 15 percent faster and has six increasing speeds', () => {
    const options = new GeneralOptions();
    expect(campaignSpeedFactor(options.campaignSpeed.value) / GameSpeed.computeGameSpeed(3)).toBeCloseTo(1.15);
    const factors = [1,2,3,4,5,6].map(campaignSpeedFactor);
    expect(factors.every((v,i) => !i || v > factors[i-1])).toBe(true);
});

test('campaign speed persists and legacy or invalid preferences keep the default', () => {
    const options = new GeneralOptions();
    options.campaignSpeed.value = 6;
    expect(new GeneralOptions().unserialize(options.serialize()).campaignSpeed.value).toBe(6);
    const legacy = options.serialize().split(',').slice(0,9).join(',');
    for (const data of [legacy, `${legacy},0`, `${legacy},7`, `${legacy},NaN`]) {
        expect(new GeneralOptions().unserialize(data).campaignSpeed.value).toBe(3);
    }
});

test('campaign movies use zero-based list positions rather than INI keys', () => {
    const art = new IniFile('[Movies]\n67=S02_f00e\n68=A01_p01e\n69=A01_p02e\n70=A01_p03e\n');
    expect(resolveCampaignMovie(art,1)).toBe('A01_p01e');
    expect(resolveCampaignMovie(art,3)).toBe('A01_p03e');
    expect(() => resolveCampaignMovie(art,67)).toThrow();
});
