import { expect, test } from 'bun:test';
// Initialize the engine's movement inheritance cycle before importing Game.
import '../game/gameobject/task/harvester/TeleportMoveToRefineryTask';
import { Game } from '../game/Game';
import { World } from '../game/World';
import { Traits } from '../game/Traits';
import { GameObject } from '../game/gameobject/GameObject';
import { ObjectType } from '../engine/type/ObjectType';
import { CrateGeneratorTrait } from '../game/trait/CrateGeneratorTrait';
import { NotifyTick } from '../game/trait/interface/NotifyTick';
import { NotifyUnspawn } from '../game/trait/interface/NotifyUnspawn';
import { PowerupType } from '../game/type/PowerupType';

// Use the real spawn/destruction/removal path; only map geometry and rendering
// are stubbed. World.removeObject must keep rejecting duplicate removals.
function fixture() {
    const game = Object.create(Game.prototype) as Game;
    const generator = new CrateGeneratorTrait(false);
    let nextId = 1;
    Object.assign(game, {
        world: new World(), traits: new Traits(), updatableObjects: new Set(),
        events: { dispatch() {} },
        map: {
            mapBounds: { isWithinBounds: () => true },
            getGroundObjectsOnTile: () => [], getTileZone: () => 0,
            terrain: { getPassableSpeed: () => 1 },
            tileOccupation: { occupyTileRange() {}, unoccupyTileRange() {} },
        },
        rules: { crateRules: { crateImg: 'CRATE', crateRegen: 1 / 450 }, getOverlayId: () => 0 },
        generateRandom: () => 0,
        createObject(type: ObjectType, name: string) {
            const obj = new GameObject(type, name, {}, {});
            obj.id = nextId++;
            obj.position = {};
            return obj;
        },
    });
    game.traits.add(generator);
    const spawn = () => generator.spawnCrateAt({ rx: nextId, ry: 0, rampType: 0 }, { type: PowerupType.Money }, game);
    return { game, generator, spawn, tick: () => generator[NotifyTick.onTick](game) };
}

test('destroyed crate is forgotten before its old expiration timer fires', () => {
    const { game, generator, spawn, tick } = fixture();
    const crate = spawn();
    game.destroyObject(crate);
    expect(crate.isDisposed).toBe(true);
    expect(() => tick()).not.toThrow();
    expect(generator.peekInsideCrate(crate)).toBeUndefined();
    expect(game.world.getAllObjects()).toHaveLength(0);
});

test('external crate removal cannot be picked up or expire again', () => {
    const { game, generator, spawn, tick } = fixture();
    const crate = spawn();
    game.unspawnObject(crate);
    expect(generator.peekInsideCrate(crate)).toBeUndefined();
    expect(generator.pickupCrate({}, crate, game)).toBeUndefined();
    expect(() => tick()).not.toThrow();
});

test('multiple crates expiring together are all removed exactly once', () => {
    const { game, generator, spawn, tick } = fixture();
    const crates = [spawn(), spawn(), spawn()];
    tick();
    for (const crate of crates) {
        expect(crate.isDisposed).toBe(true);
        expect(generator.peekInsideCrate(crate)).toBeUndefined();
    }
    expect(game.world.getAllObjects()).toHaveLength(0);
    expect(() => tick()).not.toThrow();
    expect(() => game.world.removeObject(crates[0])).toThrow('Trying to remove non-existent object');
});

test('expiry callback destroying another crate does not remove it twice', () => {
    const { game, spawn, tick } = fixture();
    const first = spawn(), second = spawn();
    game.traits.add({
        [NotifyUnspawn.onUnspawn](obj: GameObject) {
            if (obj === first) game.destroyObject(second);
        },
    });
    expect(() => tick()).not.toThrow();
    expect(game.world.getAllObjects()).toHaveLength(0);
    expect(first.isDisposed && second.isDisposed).toBe(true);
});

test('collected crate grants its reward once and never expires again', () => {
    const { game, generator, spawn, tick } = fixture();
    const crate = spawn();
    const player = { cratesPickedUp: 0 };
    let rewards = 0;
    generator.grantPowerup = () => { rewards++; return PowerupType.Money; };
    game.rules.powerups = { powerups: [{ type: PowerupType.Money }] };
    expect(generator.pickupCrate({ owner: player }, crate, game)).toBe(PowerupType.Money);
    expect(generator.pickupCrate({ owner: player }, crate, game)).toBeUndefined();
    expect(() => tick()).not.toThrow();
    expect(rewards).toBe(1);
    expect(player.cratesPickedUp).toBe(1);
    expect(crate.isDisposed).toBe(true);
});
