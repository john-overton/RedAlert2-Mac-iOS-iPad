import { IniFile, IniSection } from '../../data/IniFile';
import { CampaignScenario } from '../../data/campaign/CampaignScenario';
import type { CampaignTeams } from './CampaignTeams';
import { campaignScriptTypes } from './CampaignCapabilities';

/** Prepare custom countries without replacing the original numeric country IDs. */
export function prepareCampaignRules(base: IniFile, merged: IniFile, scenario: CampaignScenario, sourceGame?: 'ra2' | 'yr'): IniFile {
    const result = merged.clone();
    const baseCountries = base.getSection('Countries');
    if (!baseCountries) throw new Error('Base rules have no Countries list');
    const baseNames = [...new Set([...baseCountries.entries.values()].map(String))];
    // Classic maps encode trigger house references against RA2's base country
    // order plus their custom countries. YR inserts YuriCountry ahead of GDI,
    // shifting victory, ownership and production targets. Keep the source IDs
    // for these campaigns and append YR's country after the scenario countries.
    // All country/unit definitions still come from the active (YR) rules.
    const deferred: string[] = sourceGame === 'ra2' ? baseNames.filter(name => name === 'YuriCountry') : [];
    const names = baseNames.filter(name => !deferred.includes(name));
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
        const inherited = parent ? resolve(parent).clone() : (base.getSection(name)?.clone() ?? section.clone());
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
    for (const name of deferred) if (!names.includes(name)) names.push(name);
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
    teams!: CampaignTeams;
    readonly presentation: any[] = [];
    readonly productionHouses = new Set<number>();
    readonly aiTriggerHouses = new Set<number>();
    readonly firedTriggers = new Set<string>();
    readonly selectedUnitIds = new Set<number>();
    inputLocked = false;
    musicTheme?: string;
    outcome?: 'victory' | 'defeat';
    constructor(readonly scenario: CampaignScenario, readonly difficulty: 'easy' | 'medium' | 'hard' = 'medium') {
        this.musicTheme = scenario.basic.Theme;
    }
    present(event: any): void { this.presentation.push(event); }
    isCivilianHouse(player: any): boolean {
        let country = player.country?.name;
        const seen = new Set<string>();
        while (country && !seen.has(country)) {
            if (country === 'Neutral' || country === 'Special') return true;
            seen.add(country);
            country = this.scenario.ini.getSection(country)?.getString('ParentCountry');
        }
        return false;
    }
    execute(game: any, action: any, trigger?: any): void {
        if (this.outcome) return;
        const p = action.params;
        switch (action.type) {
            case 1: case 2: {
                const human = game.getPlayerByName(this.scenario.playerHouse.id);
                const applies = human.country.id === Number(p[1]);
                this.outcome = (action.type === 1) === applies ? 'victory' : 'defeat';
                human.defeated = this.outcome === 'defeat';
                this.inputLocked = false;
                game.end();
                break;
            }
            case 6: this.teams.hunt(game, Number(p[1])); break;
            case 20: this.musicTheme = String(p[1]); break;
            case 38: {
                const source = game.getAllPlayers().find((player: any) => player.country?.name === trigger.houseName);
                const target = game.getAllPlayers().find((player: any) => player.country?.id === Number(p[1]));
                if (!source || !target) throw new Error('Unknown campaign alliance house');
                game.alliances.setCampaignEnemy(source, target);
                break;
            }
            case 3: this.productionHouses.add(Number(p[1])); break;
            case 4: this.teams.requestCreate(game, String(p[1])); break;
            case 5: this.teams.dissolve(String(p[1])); break;
            case 7: this.teams.create(game, String(p[1]), true); break;
            case 80: this.teams.create(game, String(p[1]), true, Number(p[6])); break;
            case 46: this.inputLocked = true; break;
            case 47: this.inputLocked = false; break;
            case 48: this.present({kind:'camera', waypoint:Number(p[6]), speed:Number(p[1])}); break;
            case 74: this.aiTriggerHouses.add(Number(p[1])); break;
            case 100: this.present({kind:'movie', movie:String(p[1])}); break;
            case 104: this.teams.flash(game, String(p[1]), Number(p[6])); break;
            case 114: this.present({kind:'tab', tab:Number(p[1])}); break;
            case 115: this.present({kind:'cameo', name:String(p[1]), frames:Number(p[6])}); break;
            default: throw new Error(`Unsupported campaign action ${action.type}`);
        }
    }

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
        const human = byName.get(this.scenario.playerHouse.id);
        human.campaignControlHouses = new Set(this.scenario.houses
            .filter(house => this.scenario.ini.getSection(house.id)!.getBool('PlayerControl'))
            .map(house => byName.get(house.id)));
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
        const unsupportedScripts = this.scenario.audit().scriptTypes.filter((s: any) => !campaignScriptTypes.has(s));
        if (audit.unsupportedActions.length || audit.unsupportedEvents.length || unsupportedScripts.length) {
            throw new Error('Campaign contains unsupported instructions');
        }
    }
}
