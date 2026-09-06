import type { CampaignScenario } from '../../data/campaign/CampaignScenario';
import { PlaceBuildingAction } from '../action/PlaceBuildingAction';
import { QueueStatus } from '../player/production/ProductionQueue';
import { ObjectType } from '../../engine/type/ObjectType';
import { MoveTask } from '../gameobject/task/move/MoveTask';
import { AttackMoveTask } from '../gameobject/task/move/AttackMoveTask';
import { CaptureBuildingTask } from '../gameobject/task/CaptureBuildingTask';
import { EnterTransportTask } from '../gameobject/task/EnterTransportTask';
import { AttackTask } from '../gameobject/task/AttackTask';
import { EvacuateTransportTask } from '../gameobject/task/EvacuateTransportTask';
import { ScatterTask } from '../gameobject/task/ScatterTask';
import { ParadropTask } from '../gameobject/task/ParadropTask';
import { StanceType } from '../gameobject/infantry/StanceType';
import { ZoneType } from '../gameobject/unit/ZoneType';
import { Coords } from '../Coords';
import { MovementZone } from '../type/MovementZone';
import { RadialTileFinder } from '../map/tileFinder/RadialTileFinder';


export function decodeWaypoint(value: string): number {
    if (/^\d+$/.test(value)) return Number(value);
    if (!/^[A-Z]+$/.test(value)) throw new Error(`Invalid waypoint ${value}`);
    return [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}
interface Team {
    id: string;
    members: any[];
    lines: number[][];
    line: number;
    started: boolean;
    until?: number;
    target?: any;
    transports?: any[];
    successful?: boolean;
    recruitable?: boolean;
}

/** Scenario teams use deterministic simulation tasks, independently of skirmish bots. */
export class CampaignTeams {
    readonly active: Team[] = [];
    readonly pending: string[] = [];
    private assigned = new Map<any, Team>();
    constructor(readonly scenario: CampaignScenario) {}

    create(game: any, id: string, reinforce = false, waypoint?: number): Team | undefined {
        const definition = this.scenario.teams.find(t => t.id === id);
        if (!definition) throw new Error(`Unknown campaign team ${id}`);
        const p = definition.properties;
        const owner = game.getAllPlayers().find((v: any) => v.country?.name === p.House);
        if (!owner) throw new Error(`Unknown team house ${p.House}`);
        const force = this.scenario.taskForces.find(f => f.id === p.TaskForce)!;
        const script = this.scenario.scripts.find(s => s.id === p.Script)!;
        const lines = Object.entries(script.properties).filter(([k]) => /^\d+$/.test(k))
            .sort(([a], [b]) => Number(a) - Number(b)).map(([, v]) => v.split(',').map(Number));
        const members: any[] = [];
        const requirements = Object.entries(force.properties).filter(([k]) => /^\d+$/.test(k))
            .sort(([a], [b]) => Number(a) - Number(b));
        for (const [, value] of requirements) {
            const [count, name] = value.split(',');
            for (let i = 0; i < Number(count); i++) {
                if (!reinforce) {
                    const origin = p.Waypoint ? game.map.getTileAtWaypoint(decodeWaypoint(p.Waypoint)) : undefined;
                    const candidates = owner.getOwnedObjects().filter((u: any) => u.name === name && u.isSpawned &&
                        !u.isDestroyed && !members.includes(u) && (!this.assigned.has(u) || this.assigned.get(u)!.recruitable));
                    const recruitmentRank = (unit: any) => {
                        const assigned = this.assigned.get(unit);
                        return !assigned ? 0 : assigned.line >= assigned.lines.length ? 1 : 2;
                    };
                    candidates.sort((a: any, b: any) => recruitmentRank(a)-recruitmentRank(b) ||
                        (origin ? Math.hypot(a.tile.rx-origin.rx,a.tile.ry-origin.ry)-Math.hypot(b.tile.rx-origin.rx,b.tile.ry-origin.ry) : 0) || a.id-b.id);
                    const unit = candidates[0];
                    if (!unit) return undefined; // Recruitment must never conjure missing units.
                    members.push(unit);
                } else {
                    // Rules owns separate type tables; names can overlap between other object categories.
                    let rules: any;
                    for (const candidate of [ObjectType.Infantry, ObjectType.Vehicle, ObjectType.Aircraft]) {
                        try { rules = game.rules.getObject(name, candidate); } catch { continue; }
                        if (rules) break;
                    }
                    if (!rules) throw new Error(`Unknown reinforcement unit ${name}`);
                    const tile = game.map.getTileAtWaypoint(waypoint ?? decodeWaypoint(p.Waypoint ?? 'A'));
                    if (!tile) throw new Error(`Missing reinforcement waypoint for ${id}`);
                    const unit = game.createUnitForPlayer(rules, owner);
                    const flying = rules.type === ObjectType.Aircraft || rules.movementZone === MovementZone.Fly;
                    const spawnTile = new RadialTileFinder(game.map.tiles, game.map.mapBounds, tile, {width:1,height:1}, 0, 20,
                        (t: any) => (flying || game.map.terrain.getPassableSpeed(t, rules.speedType, unit.isInfantry(), !!t.onBridgeLandType) > 0) &&
                            !game.map.getGroundObjectsOnTile(t).some((o: any) => o.isTechno()), false).getNextTile();
                    if (!spawnTile) throw new Error(`No passable reinforcement cell for ${id}/${name}`);
                    if (flying) {
                        unit.zone = ZoneType.Air;
                        unit.position.tileElevation = Coords.worldToTileHeight(rules.flightLevel ?? game.rules.general.flightLevel);
                    }
                    unit.onBridge = !flying && spawnTile.onBridgeLandType !== undefined;
                    if (p.Droppod === 'yes' && unit.isInfantry()) {
                        unit.stance = StanceType.Paradrop;
                        unit.position.tileElevation = Coords.worldToTileHeight(game.rules.general.flightLevel);
                    }
                    game.spawnObject(unit, spawnTile);
                    if (p.Droppod === 'yes' && unit.isInfantry()) unit.unitOrderTrait.addTask(new ParadropTask(game).setCancellable(false));
                    members.push(unit);
                }
            }
        }
        const team: Team = {id, members, lines, line:0, started:false, recruitable:p.AreTeamMembersRecruitable === 'yes'};
        for (const unit of members) {
            const previous = this.assigned.get(unit);
            if (previous) previous.members = previous.members.filter(u => u !== unit);
            this.assigned.set(unit, team);
            if (reinforce) unit.veteranTrait?.setVeteranLevel(Math.max(0, Math.min(2, Number(p.VeteranLevel ?? 1) - 1)));
            if (p.Tag && p.Tag !== '<none>') game.triggers.attachTarget(p.Tag, unit);
            if (!reinforce) { unit.unitOrderTrait?.clearOrders(); unit.unitOrderTrait?.cancelAllTasks(); }
        }
        if (reinforce && p.Full === 'yes') {
            const transports = members.filter(u => u.transportTrait);
            for (const unit of members.filter(u => !u.transportTrait)) {
                const transport = transports.find(t => t.transportTrait.unitFitsInside(unit));
                if (transport) {
                    game.limboObject(unit, {selected:false, inTransport:true});
                    transport.transportTrait.units.push(unit);
                }
            }
        }
        this.active.push(team);
        return team;
    }

    requestCreate(game: any, id: string): void {
        if (!this.create(game, id)) this.pending.push(id);
    }
    hunt(game: any, house: number): void {
        const owner = game.getAllPlayers().find((player: any) => player.country?.id === house);
        if (!owner) throw new Error(`Unknown hunt house ${house}`);
        const members = owner.getOwnedObjects().filter((unit: any) => unit.isUnit() && unit.isSpawned);
        for (const unit of members) {
            const previous = this.assigned.get(unit);
            if (previous) previous.members = previous.members.filter(member => member !== unit);
            unit.unitOrderTrait.clearOrders(); unit.unitOrderTrait.cancelAllTasks();
        }
        const team: Team = {id:`hunt-${house}`,members,lines:[[0,1],[6,1]],line:0,started:false};
        members.forEach((unit: any) => this.assigned.set(unit, team));
        this.active.push(team);
    }
    dissolve(id: string): void {
        for (let i=this.pending.length-1;i>=0;i--) if (this.pending[i]===id) this.pending.splice(i,1);
        for (const team of [...this.active]) if (team.id === id) this.release(team);
    }
    private release(team: Team): void {
        for (const unit of team.members) if (this.assigned.get(unit) === team) this.assigned.delete(unit);
        const index = this.active.indexOf(team);
        if (index >= 0) this.active.splice(index, 1);
    }
    flash(game: any, id: string, frames: number): void {
        for (const team of this.active.filter(t => t.id === id)) {
            game.campaign.present({kind:'flash', units:team.members.map(u => u.id), frames});
        }
    }
    private advance(team: Team): void {
        team.line++; team.started = false; team.until = undefined; team.target = undefined;
    }
    private attack(game: any, team: Team, target: any): void {
        for (const unit of team.members.filter(u => u.isSpawned && u.unitOrderTrait?.isIdle())) {
            if (unit.rules.engineer && target.isBuilding() && target.rules.capturable) {
                unit.unitOrderTrait.addTask(new CaptureBuildingTask(game, target));
                continue;
            }
            const dest = game.createTarget(target, target.tile);
            const weapon = unit.attackTrait?.selectWeaponVersus(unit, dest, game, true);
            if (weapon) unit.unitOrderTrait.addTask(new AttackTask(game, dest, weapon, {force:true}));
        }
    }
    private updateBaseProduction(game: any): void {
        if (game.currentTick % 60) return;
        for (const house of this.scenario.houses) {
            const owner = game.getPlayerByName(house.id);
            if (owner.campaignControlHouses || this.scenario.ini.getSection(house.id)!.getBool('PlayerControl') ||
                !game.campaign.productionHouses.has(owner.country.id)) continue;
            const nodes = Object.entries(house.properties).filter(([key]) => /^\d{3}$/.test(key))
                .sort(([a], [b]) => Number(a)-Number(b));
            for (const [, node] of nodes) {
                const [name, x, y] = node.split(',');
                if ([...owner.buildings].some((building: any) => building.name === name && building.tile.rx === Number(x) && building.tile.ry === Number(y))) continue;
                const rules = game.rules.getObject(name, ObjectType.Building);
                if (!owner.production.isAvailableForProduction(rules)) break;
                const queue = owner.production.getQueueForObject(rules);
                if (queue.status === QueueStatus.Idle) queue.push(rules, 1, rules.cost);
                if (queue.status === QueueStatus.Ready && queue.getFirst()?.rules === rules) {
                    const action = new PlaceBuildingAction(game, true);
                    Object.assign(action, {player:owner, buildingRules:rules, tile:{x:Number(x),y:Number(y)}});
                    action.process();
                }
                break;
            }
        }
    }
    private updateAi(game: any): void {
        if (game.currentTick % 60) return;
        const campaign = game.campaign;
        const difficultyIndex = {easy:15, medium:16, hard:17}[campaign.difficulty as 'easy' | 'medium' | 'hard'];
        for (const [id, raw] of this.scenario.ini.getSection('AITriggerTypes')?.entries ?? []) {
            const f = String(raw).split(',');
            if (f[difficultyIndex] !== '1' || this.scenario.ini.getSection('AITriggerTypesEnable')?.getString(id) === 'no') continue;
            const owner = game.getAllPlayers().find((p: any) => p.country?.name === f[2]);
            if (!owner || !campaign.aiTriggerHouses.has(owner.country.id) || !campaign.productionHouses.has(owner.country.id)) continue;
            const definition = this.scenario.teams.find(t => t.id === f[1]);
            if (!definition || this.active.filter(t => t.id === definition.id).length >= Number(definition.properties.Max)) continue;
            // Mission one's local AI triggers count structures owned by the producing house.
            if (![0,1,4].includes(Number(f[4]))) throw new Error(`Unsupported campaign AI condition ${f[4]}`);
            const bytes = (f[6].match(/../g) ?? []).map(v => parseInt(v,16));
            const value = new DataView(new Uint8Array(bytes).buffer).getUint32(0,true);
            const op = new DataView(new Uint8Array(bytes).buffer).getUint32(4,true);
            const subject = Number(f[4]) === 0 ? game.getPlayerByName(this.scenario.playerHouse.id) : owner;
            const count = subject.getOwnedObjects().filter((u: any) => u.name === f[5]).length;
            if (Number(f[4]) !== 4 && ![count < value,count <= value,count === value,count >= value,count > value,count !== value][op]) continue;
            if (this.create(game,definition.id)) continue;
            const force = this.scenario.taskForces.find(t => t.id === definition.properties.TaskForce)!;
            for (const [key, rawRequirement] of Object.entries(force.properties)) {
                if (!/^\d+$/.test(key)) continue;
                const [quantity,name] = rawRequirement.split(',');
                const type = [ObjectType.Infantry,ObjectType.Vehicle,ObjectType.Aircraft].find(t => game.rules.hasObject(name,t));
                if (type === undefined) throw new Error(`Unknown AI unit ${name}`);
                const rules = game.rules.getObject(name,type);
                if (!owner.production.isAvailableForProduction(rules)) continue;
                const queue = owner.production.getQueueForObject(rules);
                const available = owner.getOwnedObjects().filter((u: any) => u.name === name && !this.assigned.has(u)).length;
                const queued = queue.find(rules).reduce((n: number,item: any) => n + item.quantity,0);
                const missing = Number(quantity)-available-queued;
                if (missing > 0) queue.push(rules,missing,rules.cost);
            }
        }
    }
    update(game: any): void {
        for (let i=0;i<this.pending.length;) {
            if (this.create(game, this.pending[i])) this.pending.splice(i,1); else i++;
        }
        this.updateBaseProduction(game);
        this.updateAi(game);
        for (const team of [...this.active]) {
            for (const unit of team.members) if (unit.isDestroyed) this.assigned.delete(unit);
            team.members = team.members.filter(u => !u.isDestroyed);
            if (!team.members.length) { this.release(team); continue; }
            if (team.line >= team.lines.length) continue;
            const [op, arg] = team.lines[team.line];
            const units = team.members.filter(u => u.isSpawned);
            if (!units.length) continue;
            const idle = units.every(u => u.unitOrderTrait?.isIdle());
            switch (op) {
                case 0: case 1: case 46: case 47: {
                    if (team.target && game.areFriendly(units[0], team.target)) { this.advance(team); break; }
                    if (team.target?.isDestroyed || !team.target?.isSpawned) {
                        if (team.target && op !== 0) { this.advance(team); break; }
                        team.target = undefined;
                        const owner = units[0].owner;
                        let targets = game.getAllPlayers().filter((p: any) => p !== owner && !game.alliances.areAllied(owner, p))
                            .flatMap((p: any) => p.getOwnedObjects()).filter((u: any) => u.isSpawned && !u.isDestroyed && u.rules.legalTarget);
                        let center = units[0].tile;
                        if (op === 1) {
                            center = game.map.getTileAtWaypoint(arg);
                            if (!center) throw new Error(`Missing attack waypoint ${arg}`);
                            targets = targets.filter((u: any) => Math.hypot(u.tile.rx-center.rx,u.tile.ry-center.ry) <= 4);
                        } else if ((op === 46 || op === 47)) {
                            const rules = game.rules.getTechnoByInternalId(arg & 65535, ObjectType.Building);
                            targets = targets.filter((u: any) => u.name === rules.name);
                        } else if (arg !== 1) {
                            targets = targets.filter((u: any) => arg === 2 ? u.isBuilding() : arg === 3 ? !!u.harvesterTrait : arg === 4 ? u.isInfantry() : arg === 5 ? u.isVehicle() : true);
                        }
                        targets.sort((a: any,b: any) => Math.hypot(a.tile.rx-center.rx,a.tile.ry-center.ry)-Math.hypot(b.tile.rx-center.rx,b.tile.ry-center.ry) || a.id-b.id);
                        if ((op === 46 || op === 47) && (arg >>> 16) === 3) targets.reverse();
                        team.target = targets.find((t: any) => op === 47 || units.some(u => (u.rules.engineer && t.isBuilding() && t.rules.capturable) || u.attackTrait?.selectWeaponVersus(u, game.createTarget(t,t.tile),game,true)));
                        if (!team.target) { if (op !== 1) this.advance(team); break; }
                    }
                    if (op === 47) {
                        if (!team.started) {
                            for (const unit of units) unit.unitOrderTrait.addTask(new MoveTask(game, team.target.tile, false, {closeEnoughTiles:4}));
                            team.started = true;
                        } else if (idle) this.advance(team);
                    } else this.attack(game, team, team.target);
                    break;
                }
                case 3: case 16: {
                    const tile = game.map.getTileAtWaypoint(arg);
                    if (!tile) throw new Error(`Missing move waypoint ${arg}`);
                    if (!team.started) {
                        if (!idle) break;
                        for (const unit of units) unit.unitOrderTrait.addTask(new (op === 16 ? AttackMoveTask : MoveTask)(game, tile, !!tile.onBridgeLandType, {closeEnoughTiles:2, allowOutOfBoundsTarget:true}));
                        team.started = true;
                    } else if (idle) this.advance(team);
                    break;
                }
                case 5:
                    if (!team.started) { units.forEach(u => u.guardMode = true); team.until = game.currentTick + arg * 15; team.started = true; }
                    if (game.currentTick >= team.until!) this.advance(team);
                    break;
                case 6: // Editor line numbers are one based.
                    team.line = Math.max(0, arg - 1); team.started = false; team.target = undefined; break;
                case 8:
                    if (!team.started) {
                        team.transports = units.filter(u => u.transportTrait);
                        for (const unit of team.transports) unit.unitOrderTrait.addTask(new EvacuateTransportTask(game, true));
                        team.started = true;
                    } else if (team.transports!.every(u => u.isDestroyed || !u.transportTrait.units.length)) {
                        const removed = team.members.filter(u => (!!(arg & 2) && !!u.transportTrait) || (!!(arg & 1) && !u.transportTrait));
                        for (const unit of removed) this.assigned.delete(unit);
                        team.members = team.members.filter(u => !removed.includes(u));
                        this.advance(team);
                    }
                    break;
                case 11:
                    if (arg === 6 || arg === 14) { team.lines[team.line] = [0, arg === 14 ? 2 : 1]; break; }
                    units.forEach(u => { u.unitOrderTrait.clearOrders(); u.unitOrderTrait.cancelAllTasks(); u.guardMode = arg !== 0; });
                    team.line = team.lines.length; break;
                case 14: {
                    const passengers = units.filter(unit => !unit.transportTrait);
                    for (const unit of passengers.filter(unit => unit.unitOrderTrait.isIdle())) {
                        const transport = units.find(t => t.transportTrait?.unitFitsInside(unit));
                        if (transport) unit.unitOrderTrait.addTask(new EnterTransportTask(game, transport));
                    }
                    if (!passengers.length || passengers.every(unit => !units.some(t => t.transportTrait?.unitFitsInside(unit)))) this.advance(team);
                    break;
                }
                case 43:
                    if (units.filter(unit => unit.transportTrait).every(unit =>
                        !team.members.some(member => !member.transportTrait && member.isSpawned && unit.transportTrait.unitFitsInside(member)))) this.advance(team);
                    break;
                case 45:
                    // Retail supply-truck cargo imagery; no resource transfer occurs.
                    units.forEach(unit => { unit.campaignTruckLoaded = true; });
                    this.advance(team); break;
                case 19:
                    units.filter(u => u.isInfantry()).forEach(u => u.isPanicked = true);
                    if (idle) units.forEach(u => u.unitOrderTrait.addTask(new ScatterTask(game)));
                    this.advance(team); break;
                case 20: {
                    const owner = game.getAllPlayers().find((p: any) => p.country?.id === arg);
                    if (!owner) throw new Error(`Unknown script house ${arg}`);
                    team.members.forEach(u => game.changeObjectOwner(u, owner)); this.advance(team); break;
                }
                case 37:
                    for (const unit of team.members) game.destroyObject(unit, undefined, true);
                    this.release(team); break;
                case 39: game.triggers.toggleLocalVariable(String(arg),true); this.advance(team); break;
                case 49: team.successful = true; this.advance(team); break;
                case 50: this.flash(game,team.id,arg); this.advance(team); break;
                default: throw new Error(`Unsupported campaign script ${op}`);
            }
        }
    }
}
