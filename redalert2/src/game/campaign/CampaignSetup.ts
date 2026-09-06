import { IniFile, IniSection } from '../../data/IniFile';
import { CampaignScenario } from '../../data/campaign/CampaignScenario';

/** Prepare custom countries without replacing the original numeric country IDs. */
export function prepareCampaignRules(base: IniFile, merged: IniFile, scenario: CampaignScenario): IniFile {
    const result = merged.clone();
    const baseCountries = base.getSection('Countries');
    if (!baseCountries) throw new Error('Base rules have no Countries list');
    const names = [...new Set([...baseCountries.entries.values()].map(String))];
    const ancestors = new Map<string, string[]>();
    const resolving = new Set<string>();
    const resolved = new Map<string, IniSection>();
    const resolve = (name: string): IniSection => {
        if (resolved.has(name)) return resolved.get(name)!;
        if (resolving.has(name)) throw new Error(`Circular campaign country inheritance: ${name}`);
        const section = scenario.ini.getSection(name) ?? base.getSection(name);
        if (!section) throw new Error(`Missing campaign country ${name}`);
        resolving.add(name);
        const parent = section.getString('ParentCountry');
        const inherited = parent ? resolve(parent).clone() : section.clone();
        inherited.name = name;
        inherited.mergeWith(section);
        ancestors.set(name, parent ? [parent, ...(ancestors.get(parent) ?? [])] : []);
        resolving.delete(name);
        resolved.set(name, inherited);
        return inherited;
    };
    for (const definition of scenario.countries) {
        if (!names.includes(definition.id)) names.push(definition.id);
        const section = resolve(definition.id).clone();
        // Campaign houses are managed participants even when their parent was a
        // passive country. Neutral world objects retain the base neutral player.
        section.set('Multiplay', 'yes');
        section.set('MultiplayPassive', 'no');
        result.sections.set(definition.id, section);
    }
    result.sections.set('Countries', new IniSection('Countries').fromJson(Object.fromEntries(names.map((name, i) => [i, name]))));
    for (const section of result.sections.values()) {
        for (const key of ['Owner', 'RequiredHouses', 'ForbiddenHouses']) {
            if (!section.has(key)) continue;
            const owners = section.getArray(key);
            for (const definition of scenario.countries) {
                if ((ancestors.get(definition.id) ?? []).some(parent => owners.includes(parent)) && !owners.includes(definition.id)) {
                    owners.push(definition.id);
                }
            }
            section.set(key, owners.join(','));
        }
    }
    return result;
}

export class CampaignSetup {
    constructor(readonly scenario: CampaignScenario) {}

    createPlayers(game: any, factory: any, createCountry: (name: string) => any): void {
        const referenceErrors = this.scenario.referenceErrors();
        if (referenceErrors.length) throw new Error(referenceErrors.join('\n'));
        for (const house of this.scenario.houses) {
            const section = this.scenario.ini.getSection(house.id)!;
            const colorName = section.getString('Color');
            const color = game.rules.colors.get(colorName);
            if (!color) throw new Error(`Unknown campaign house color ${colorName}`);
            const player = factory.createCombatant(house.id, createCountry(house.properties.Country), 0,
                color, house.id !== this.scenario.playerHouse.id, undefined);
            player.credits = section.getNumber('Credits') * 100;
            player.production.setTechLevel(section.getNumber('TechLevel'));
            game.addPlayer(player);
        }
        const players = game.getAllPlayers();
        const byName = new Map<string, any>(players.map((player: any) => [player.name, player]));
        const relations = new Map<any, any[]>();
        for (const house of this.scenario.houses) {
            const player = byName.get(house.id);
            const names = this.scenario.ini.getSection(house.id)!.getArray('Allies');
            relations.set(player, names.filter(name => name !== house.id).map(name => byName.get(name)));
        }
        game.alliances.setCampaignAllies(relations);
    }

    initialCameraPosition(): { x: number; y: number } {
        const value = this.scenario.ini.getSection('Waypoints')!.getNumber(String(this.scenario.homeWaypoint));
        return { x: value % 1000, y: Math.floor(value / 1000) };
    }

    hasFreeRadar(player: any): boolean {
        return player.name === this.scenario.playerHouse.id && this.scenario.ini.getSection('Basic')!.getBool('FreeRadar');
    }

    assertReadyToStart(): void {
        const audit = this.scenario.audit();
        // Initialization can be inspected independently. Do not run the mission
        // with its unsupported conditions/actions silently removed by MapFile.
        throw new Error(`Campaign runtime is still under development: ${audit.unsupportedActions.length} unsupported action types, ` +
            `${audit.unsupportedEvents.length} unsupported event types; scripted teams and mission outcomes remain required.`);
    }
}
