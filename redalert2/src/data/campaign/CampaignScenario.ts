import { IniFile, IniSection } from '../IniFile';
import { TriggerActionType } from '../map/trigger/TriggerActionType';
import { TriggerEventType } from '../map/trigger/TriggerEventType';

export interface ScenarioInstruction {
    type: number;
    /** Original parameters, including the parameter-kind field; no lossy coercion. */
    params: string[];
}

export interface ScenarioTrigger {
    id: string;
    house: string;
    linkedTrigger?: string;
    name: string;
    disabled: boolean;
    difficulties: { easy: boolean; medium: boolean; hard: boolean };
    flags: string[];
    events: ScenarioInstruction[];
    actions: ScenarioInstruction[];
}

export interface ScenarioDefinition {
    id: string;
    properties: Record<string, string>;
}

function entries(section?: IniSection): [string, string][] {
    return [...section?.entries ?? []].map(([key, value]) => {
        if (typeof value !== 'string') throw new Error(`Expected scalar [${section?.name}] ${key}`);
        return [key, value];
    });
}

function required(ini: IniFile, name: string): IniSection {
    const section = ini.getSection(name);
    if (!section) throw new Error(`Campaign is missing [${name}]`);
    return section;
}

function integer(value: string, context: string): number {
    if (!/^\d+$/.test(value)) throw new Error(`Invalid integer ${JSON.stringify(value)} in ${context}`);
    return Number(value);
}

function definitions(ini: IniFile, list: string): ScenarioDefinition[] {
    return entries(ini.getSection(list))
        .sort(([a], [b]) => integer(a, list) - integer(b, list))
        .map(([, id]) => ({ id, properties: Object.fromEntries(entries(required(ini, id))) }));
}

function instructions(raw: string | undefined, kind: 'Actions' | 'Events', id: string): ScenarioInstruction[] {
    if (raw === undefined) throw new Error(`Missing [${kind}] for trigger ${id}`);
    const tokens = raw.split(',').map(token => token.trim());
    const count = integer(tokens.shift()!, `${kind}/${id}`);
    const result: ScenarioInstruction[] = [];
    for (let index = 0; index < count; index++) {
        const type = integer(tokens.shift() ?? '', `${kind}/${id}/${index}`);
        // Actions have seven parameter fields. Events have a kind field and
        // one value, or two values when kind == 2 (the extended event encoding).
        const length = kind === 'Actions' ? 7 : tokens[0] === '2' ? 3 : 2;
        if (tokens.length < length) throw new Error(`Truncated [${kind}] ${id}/${index}`);
        result.push({ type, params: tokens.splice(0, length) });
    }
    if (tokens.length) throw new Error(`Unexpected trailing fields in [${kind}] ${id}`);
    return result;
}

/**
 * Campaign metadata before MapFile's skirmish-oriented processing. Unknown
 * instructions remain intact so unsupported mission logic cannot disappear.
 * Rendering/packed terrain are still handled by MapFile once launch is supported.
 */
export class CampaignScenario {
    readonly basic: Record<string, string>;
    readonly houses: ScenarioDefinition[];
    readonly countries: ScenarioDefinition[];
    readonly teams: ScenarioDefinition[];
    readonly taskForces: ScenarioDefinition[];
    readonly scripts: ScenarioDefinition[];
    readonly triggers: ScenarioTrigger[];
    readonly playerHouse: ScenarioDefinition;
    readonly homeWaypoint: number;

    constructor(readonly ini: IniFile) {
        const basic = required(ini, 'Basic');
        if (!basic.has('MultiplayerOnly') || basic.getBool('MultiplayerOnly', true)) {
            throw new Error('Expected a single-player campaign map (MultiplayerOnly=0)');
        }
        this.basic = Object.fromEntries(entries(basic));
        this.houses = definitions(ini, 'Houses');
        this.countries = definitions(ini, 'Countries');
        this.teams = definitions(ini, 'TeamTypes');
        this.taskForces = definitions(ini, 'TaskForces');
        this.scripts = definitions(ini, 'ScriptTypes');
        const playerHouse = this.houses.find(house => house.id === basic.getString('Player'));
        if (!playerHouse) throw new Error(`Unknown campaign player house ${basic.getString('Player')}`);
        this.playerHouse = playerHouse;
        this.homeWaypoint = integer(basic.getString('HomeCell'), 'Basic/HomeCell');
        if (!ini.getSection('Waypoints')?.has(String(this.homeWaypoint))) {
            throw new Error(`Missing campaign home waypoint ${this.homeWaypoint}`);
        }
        const events = new Map(entries(ini.getSection('Events')));
        const actions = new Map(entries(ini.getSection('Actions')));
        this.triggers = entries(required(ini, 'Triggers')).map(([id, raw]) => {
            const fields = raw.split(',').map(field => field.trim());
            if (fields.length < 8) throw new Error(`Truncated [Triggers] ${id}`);
            return {
                id, house: fields[0], linkedTrigger: fields[1] === '<none>' ? undefined : fields[1],
                name: fields[2], disabled: fields[3] === '1',
                difficulties: { easy: fields[4] === '1', medium: fields[5] === '1', hard: fields[6] === '1' },
                flags: fields.slice(7),
                events: instructions(events.get(id), 'Events', id),
                actions: instructions(actions.get(id), 'Actions', id),
            };
        });
    }

    /** Reference validation is separate from capability coverage. Both matter. */
    referenceErrors(): string[] {
        const errors: string[] = [];
        for (const house of this.houses) {
            if (!this.ini.getSection(house.properties.Country ?? '')) errors.push(`House ${house.id}: missing country ${house.properties.Country}`);
            for (const ally of (house.properties.Allies ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
                if (!this.houses.some(other => other.id === ally)) errors.push(`House ${house.id}: missing ally ${ally}`);
            }
        }
        for (const team of this.teams) {
            for (const [property, definitions] of [['Script', this.scripts], ['TaskForce', this.taskForces]] as const) {
                if (!definitions.some(definition => definition.id === team.properties[property])) {
                    errors.push(`Team ${team.id}: missing ${property} ${team.properties[property]}`);
                }
            }
            if (!this.houses.some(house => house.properties.Country === team.properties.House || house.id === team.properties.House)) {
                errors.push(`Team ${team.id}: missing house ${team.properties.House}`);
            }
        }
        for (const trigger of this.triggers) {
            if (trigger.linkedTrigger && !this.triggers.some(other => other.id === trigger.linkedTrigger)) {
                errors.push(`Trigger ${trigger.id}: missing linked trigger ${trigger.linkedTrigger}`);
            }
        }
        return errors;
    }

    audit() {
        const usage = (kind: 'actions' | 'events', known: object) => {
            const types = new Map<number, Set<string>>();
            for (const trigger of this.triggers) for (const instruction of trigger[kind]) {
                if ((known as Record<number, string>)[instruction.type] !== undefined) continue;
                if (!types.has(instruction.type)) types.set(instruction.type, new Set());
                types.get(instruction.type)!.add(trigger.id);
            }
            return [...types].sort(([a], [b]) => a - b).map(([type, triggers]) => ({ type, triggers: [...triggers] }));
        };
        const scriptTypes = new Set<number>();
        for (const script of this.scripts) for (const [key, value] of Object.entries(script.properties)) {
            if (/^\d+$/.test(key)) scriptTypes.add(integer(value.split(',')[0], `Script/${script.id}/${key}`));
        }
        return {
            // Enum coverage alone is not proof of campaign-runtime compatibility.
            playable: false,
            playerHouse: this.playerHouse.id,
            playerCountry: this.playerHouse.properties.Country,
            homeWaypoint: this.homeWaypoint,
            briefing: this.basic.Briefing,
            intro: this.basic.Intro,
            counts: {
                houses: this.houses.length, countries: this.countries.length,
                triggers: this.triggers.length, teams: this.teams.length,
                scripts: this.scripts.length, taskForces: this.taskForces.length,
            },
            unsupportedActions: usage('actions', TriggerActionType),
            unsupportedEvents: usage('events', TriggerEventType),
            scriptTypes: [...scriptTypes].sort((a, b) => a - b),
            referenceErrors: this.referenceErrors(),
            runtimeRequirements: ['campaign house setup', 'scripted team execution', 'campaign victory/defeat', 'campaign launch and presentation'],
        };
    }
}
