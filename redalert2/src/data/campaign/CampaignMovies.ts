import { IniFile } from '../IniFile';

/** Trigger parameters index the ordered movie list from zero, not its INI keys. */
export function resolveCampaignMovie(art: IniFile, index: number): string {
    const movies = [...(art.getSection('Movies')?.entries.values() ?? [])];
    if (!Number.isInteger(index) || index < 0 || index >= movies.length) {
        throw new Error(`Missing retail movie index ${index}`);
    }
    return String(movies[index]);
}
