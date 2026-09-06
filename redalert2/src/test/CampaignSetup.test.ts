import { expect, test } from 'bun:test';
import { IniFile } from '../data/IniFile';
import { CampaignScenario } from '../data/campaign/CampaignScenario';
import { CampaignSetup, prepareCampaignRules } from '../game/campaign/CampaignSetup';
import { Alliances, AllianceStatus } from '../game/Alliances';
import { PlayerList } from '../game/PlayerList';

function scenario() {
    return new CampaignScenario(new IniFile({
        Basic: { MultiplayerOnly: '0', Player: 'Human House', HomeCell: '98', FreeRadar: 'yes' },
        Houses: { 0: 'Human House', 1: 'Enemy House' },
        'Human House': { Country: 'Human', Color: 'Blue', Credits: '40', TechLevel: '3', Allies: 'Human House,Enemy House' },
        'Enemy House': { Country: 'Enemy', Color: 'Red', Credits: '100', TechLevel: '10', Allies: 'Enemy House' },
        Countries: { 0: 'Human', 1: 'Enemy' },
        Human: { ParentCountry: 'Americans' },
        Enemy: { ParentCountry: 'Russians' },
        Waypoints: { 98: '42017' },
        Triggers: {},
    }));
}
function baseRules() {
    return new IniFile({
        Countries: { 0: 'Americans', 1: 'Russians' },
        Americans: { Side: 'GDI', Multiplay: 'yes', VeteranInfantry: 'E1' },
        Russians: { Side: 'Nod', Multiplay: 'yes' },
        E1: { Owner: 'Americans', ForbiddenHouses: 'Russians' },
        E2: { Owner: 'Russians', RequiredHouses: 'Russians' },
    });
}

test('campaign countries append to base IDs and inherit parent rules', () => {
    const mission = scenario();
    const base = baseRules();
    const original = base.toString();
    const result = prepareCampaignRules(base, base.clone().mergeWith(mission.ini), mission);
    expect([...result.getSection('Countries')!.entries.values()]).toEqual(['Americans', 'Russians', 'Human', 'Enemy']);
    expect(result.getSection('Human')!.getString('Side')).toBe('GDI');
    expect(result.getSection('Human')!.name).toBe('Human');
    expect(result.getSection('Human')!.getArray('VeteranInfantry')).toEqual(['E1']);
    expect(base.toString()).toBe(original);
});

test('custom countries inherit ownership, required-house and forbidden-house eligibility', () => {
    const mission = scenario();
    const base = baseRules();
    const result = prepareCampaignRules(base, base.clone().mergeWith(mission.ini), mission);
    expect(result.getSection('E1')!.getArray('Owner')).toEqual(['Americans', 'Human']);
    expect(result.getSection('E1')!.getArray('ForbiddenHouses')).toEqual(['Russians', 'Enemy']);
    expect(result.getSection('E2')!.getArray('RequiredHouses')).toEqual(['Russians', 'Enemy']);
});

test('circular and missing country parents fail before game creation', () => {
    const mission = scenario();
    mission.ini.getSection('Human')!.set('ParentCountry', 'Human');
    expect(() => prepareCampaignRules(baseRules(), mission.ini, mission)).toThrow('Circular');
    mission.ini.getSection('Human')!.set('ParentCountry', 'Absent');
    expect(() => prepareCampaignRules(baseRules(), mission.ini, mission)).toThrow('Missing campaign country');
});

test('house creation uses separate identities, per-house credits/tech levels and directed allies', () => {
    const setup = new CampaignSetup(scenario());
    const playerList = new PlayerList();
    const alliances = new Alliances(playerList);
    const game = {
        rules: { colors: new Map([['Blue', {}], ['Red', {}]]) },
        addPlayer: (player: any) => playerList.addPlayer(player),
        getAllPlayers: () => playerList.getAll(), alliances,
    };
    const factory = {
        createCombatant: (name: string, country: any, _start: number, _color: any, isAi: boolean) => ({
            name, country, isAi, production: { level: -1, setTechLevel(level: number) { this.level = level; } },
        }),
    };
    setup.createPlayers(game, factory, name => ({ name }));
    const [human, enemy] = playerList.getAll() as any[];
    expect(human.name).toBe('Human House');
    expect(human.country.name).toBe('Human');
    expect([human.credits, enemy.credits]).toEqual([4000, 10000]);
    expect([human.production.level, enemy.production.level]).toEqual([3, 10]);
    expect([human.isAi, enemy.isAi]).toEqual([false, true]);
    expect(alliances.areAllied(human, enemy)).toBe(true);
    expect(alliances.areAllied(enemy, human)).toBe(false);
    expect(alliances.getAllies(human)).toEqual([enemy]);
    expect(alliances.getAllies(enemy)).toEqual([]);
    const copy = alliances.getAllies(human);
    copy.length = 0;
    expect(alliances.getAllies(human)).toEqual([enemy]);
    expect(setup.initialCameraPosition()).toEqual({ x: 17, y: 42 });
    expect(setup.hasFreeRadar(human)).toBe(true);
    expect(setup.hasFreeRadar(enemy)).toBe(false);
});

test('campaign alliance hashing includes direction', () => {
    const list = new PlayerList();
    const a = { name: 'a' } as any, b = { name: 'b' } as any;
    list.addPlayer(a); list.addPlayer(b);
    const alliances = new Alliances(list);
    alliances.setCampaignAllies(new Map([[a, [b]], [b, []]]));
    const first = alliances.getHash();
    alliances.setCampaignAllies(new Map([[a, []], [b, [a]]]));
    expect(alliances.getHash()).not.toBe(first);
});

test('skirmish alliances remain symmetric without campaign configuration', () => {
    const list = new PlayerList();
    const players = ['a', 'b', 'c'].map(name => ({ name, isCombatant: () => true } as any));
    players.forEach(player => list.addPlayer(player));
    const alliances = new Alliances(list);
    alliances.setAlliance(players[0], players[1], AllianceStatus.Formed);
    expect(alliances.areAllied(players[0], players[1])).toBe(true);
    expect(alliances.areAllied(players[1], players[0])).toBe(true);
    expect(alliances.getAllies(players[0])).toEqual([players[1]]);
    expect(alliances.getAllies(players[1])).toEqual([players[0]]);
});

test('runtime rejects unsupported instructions and accepts a covered scenario', () => {
    const mission = scenario();
    expect(() => new CampaignSetup(mission).assertReadyToStart()).not.toThrow();
    mission.scripts.push({id:'UNSUPPORTED',properties:{'0':'999,0'}});
    expect(() => new CampaignSetup(mission).assertReadyToStart()).toThrow('unsupported instructions');
});

test('campaign outcomes are explicit and do not depend on surviving allies', () => {
    for (const [type, expected] of [[1,'victory'],[2,'defeat']] as const) {
        const campaign = new CampaignSetup(scenario());
        const human = {country:{id:13},defeated:false};
        let ended = 0;
        campaign.inputLocked = true;
        campaign.execute({getPlayerByName:()=>human,end:()=>ended++},{type,params:[0,'13']});
        expect(campaign.outcome).toBe(expected);
        expect(human.defeated).toBe(expected === 'defeat');
        expect(campaign.inputLocked).toBe(false);
        expect(ended).toBe(1);
    }
});

test('campaign civilian ownership follows country inheritance without claiming allied houses', () => {
    const setup = new CampaignSetup({ini:new IniFile({
        Civilian1:{ParentCountry:'Neutral'},Town:{ParentCountry:'Civilian1'},
        Ally:{ParentCountry:'Americans'},Cycle:{ParentCountry:'Cycle'},
    })} as any);
    const civilian = (name:string) => setup.isCivilianHouse({country:{name}});
    expect(civilian('Civilian1')).toBe(true);
    expect(civilian('Town')).toBe(true);
    expect(civilian('Ally')).toBe(false);
    expect(civilian('Cycle')).toBe(false);
});
