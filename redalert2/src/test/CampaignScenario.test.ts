import { expect, test } from 'bun:test';
import { IniFile } from '../data/IniFile';
import { CampaignScenario } from '../data/campaign/CampaignScenario';

// Synthetic fixture: no retail mission content is stored in the repository.
function fixture() {
    return new IniFile({
        Basic: { MultiplayerOnly: '0', Player: 'Human House', HomeCell: '98', Briefing: 'TEST:Briefing' },
        Houses: { '0': 'Human House', '1': 'Opponent House' },
        Countries: { '0': 'HumanCountry', '1': 'OpponentCountry' },
        'Human House': { Country: 'HumanCountry', PlayerControl: 'yes', Credits: '40', Allies: 'Human House' },
        'Opponent House': { Country: 'OpponentCountry', PlayerControl: 'no', Credits: '100' },
        HumanCountry: { ParentCountry: 'Americans' },
        OpponentCountry: { ParentCountry: 'Russians' },
        Waypoints: { '98': '42017' },
        TeamTypes: { '0': 'TEAM' },
        TEAM: { House: 'OpponentCountry', Script: 'SCRIPT', TaskForce: 'FORCE' },
        ScriptTypes: { '0': 'SCRIPT' },
        SCRIPT: { Name: 'Synthetic script', '0': '3,98', '1': '999,0' },
        TaskForces: { '0': 'FORCE' },
        FORCE: { Name: 'Synthetic force', '0': '1,E1' },
        Triggers: { T: 'HumanCountry,<none>,Synthetic trigger,1,1,0,1,0' },
        Events: { T: '2,13,0,5,999,2,3,opaque' },
        Actions: { T: '2,11,4,TEST:Message,0,0,0,0,A,999,1,TEAM,0,0,0,0,AB' },
    });
}

test('campaign houses retain custom country, alliances, credits and home waypoint', () => {
    const scenario = new CampaignScenario(fixture());
    expect(scenario.playerHouse.id).toBe('Human House');
    expect(scenario.playerHouse.properties).toMatchObject({ Country: 'HumanCountry', Credits: '40', Allies: 'Human House' });
    expect(scenario.homeWaypoint).toBe(98);
    expect(scenario.referenceErrors()).toEqual([]);
});

test('unknown actions and extended events survive with exact parameters', () => {
    const scenario = new CampaignScenario(fixture());
    expect(scenario.triggers[0].actions[1]).toEqual({ type: 999, params: ['1', 'TEAM', '0', '0', '0', '0', 'AB'] });
    expect(scenario.triggers[0].events[1]).toEqual({ type: 999, params: ['2', '3', 'opaque'] });
    expect(scenario.audit().unsupportedActions).toEqual([{ type: 999, triggers: ['T'] }]);
    expect(scenario.audit().unsupportedEvents).toEqual([{ type: 999, triggers: ['T'] }]);
    expect(scenario.audit().scriptTypes).toEqual([3, 999]);
    expect(scenario.audit().playable).toBe(false);
});

test('disabled and difficulty-specific trigger flags are preserved', () => {
    const trigger = new CampaignScenario(fixture()).triggers[0];
    expect(trigger.disabled).toBe(true);
    expect(trigger.difficulties).toEqual({ easy: true, medium: false, hard: true });
});

test('unknown operations are attributed to every using trigger', () => {
    const ini = fixture();
    ini.getSection('Triggers')!.set('T2', 'HumanCountry,T,Second trigger,0,1,1,1,0');
    ini.getSection('Events')!.set('T2', '0');
    ini.getSection('Actions')!.set('T2', '1,999,0,0,0,0,0,0,A');
    const scenario = new CampaignScenario(ini);
    expect(scenario.triggers[1].linkedTrigger).toBe('T');
    expect(scenario.audit().unsupportedActions[0].triggers).toEqual(['T', 'T2']);
});

test('missing team dependencies are reported without losing the team definition', () => {
    const ini = fixture();
    ini.getSection('TEAM')!.set('Script', 'MISSING');
    const scenario = new CampaignScenario(ini);
    expect(scenario.teams).toHaveLength(1);
    expect(scenario.referenceErrors()).toContain('Team TEAM: missing Script MISSING');
});

test('skirmish maps cannot accidentally become campaign scenarios', () => {
    const ini = fixture();
    ini.getSection('Basic')!.set('MultiplayerOnly', '1');
    expect(() => new CampaignScenario(ini)).toThrow('single-player campaign map');
});

test('invalid player houses and absent initial camera waypoints fail early', () => {
    const ini = fixture();
    ini.getSection('Basic')!.set('Player', 'Missing');
    expect(() => new CampaignScenario(ini)).toThrow('Unknown campaign player house');
    const missingWaypoint = fixture();
    missingWaypoint.getSection('Basic')!.set('HomeCell', '99');
    expect(() => new CampaignScenario(missingWaypoint)).toThrow('home waypoint 99');
});

test('truncated, trailing and nonnumeric action records fail instead of silently skipping', () => {
    for (const record of ['1,11,4,TEST:Text', '0,extra', 'oops', '1,bad,0,0,0,0,0,0,A']) {
        const ini = fixture();
        ini.getSection('Actions')!.set('T', record);
        expect(() => new CampaignScenario(ini)).toThrow();
    }
});

test('truncated extended event parameters fail', () => {
    const ini = fixture();
    ini.getSection('Events')!.set('T', '1,999,2,3');
    expect(() => new CampaignScenario(ini)).toThrow('Truncated [Events]');
});

test('definition tables are sorted by numeric index rather than insertion order', () => {
    const ini = fixture();
    ini.getSection('Houses')!.entries = new Map([['10', 'Opponent House'], ['2', 'Human House']]);
    expect(new CampaignScenario(ini).houses.map(house => house.id)).toEqual(['Human House', 'Opponent House']);
});
