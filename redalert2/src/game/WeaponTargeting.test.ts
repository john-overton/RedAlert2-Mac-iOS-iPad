import { expect, test } from 'bun:test';
import { WeaponTargeting } from './WeaponTargeting';
import { WeaponType } from './WeaponType';
import { ZoneType } from './gameobject/unit/ZoneType';

// Characterization of existing predicate forwarding; the indexed prototype was rejected.
function baseline(this: any, ...args: any[]): boolean {
    const [target, context, alliances, forcefire, shift] = args;
    return this.targetChecks.every((check: any) => check(target, context, alliances, forcefire, shift));
}

for (const mutation of ['none', 'stop', 'delete', 'append', 'replace', 'truncate', 'replaceArray']) {
    test(`predicate invocation matches every with ${mutation}`, () => {
        const run = (method: any) => {
            const calls: any[] = [];
            const probe: any = { targetChecks: [] };
            const args = [{ target: true }, { context: true }, { alliances: true }, false, true];
            const record = (name: string, receiver: any, actual: any[]) => calls.push({ name, receiver, args: actual });
            probe.targetChecks.push(function (this: any, ...actual: any[]) {
                record('first', this, actual);
                if (mutation === 'delete') delete probe.targetChecks[1];
                if (mutation === 'append') probe.targetChecks.push(function (this: any, ...a: any[]) { record('appended', this, a); return true; });
                if (mutation === 'replace') probe.targetChecks[1] = function (this: any, ...a: any[]) { record('replaced', this, a); return true; };
                if (mutation === 'truncate') probe.targetChecks.length = 0;
                if (mutation === 'replaceArray') probe.targetChecks = [() => { throw new Error('new array must not be visited'); }];
                return mutation !== 'stop';
            }, function (this: any, ...actual: any[]) { record('second', this, actual); return true; });
            const result = method.apply(probe, args);
            for (const call of calls) {
                expect(call.receiver).toBeUndefined();
                expect(call.args).toEqual(args);
            }
            return { result, calls };
        };
        expect(run(WeaponTargeting.prototype.canTarget)).toEqual(run(baseline));
    });
}

test('exceptions propagate and prevent later predicates from running', () => {
    const error = new Error('predicate failure');
    const probe: any = { targetChecks: [() => { throw error; }, () => { throw new Error('unexpected later predicate'); }] };
    expect(() => WeaponTargeting.prototype.canTarget.call(probe)).toThrow(error);
    expect(WeaponTargeting.prototype.canTarget.call({ targetChecks: [] } as any)).toBe(true);
});

test('real airborne target checks preserve friendly, cloak, invulnerability and force-fire behavior', () => {
    const owner = {};
    const shooter: any = { name: 'JUMPJET', owner, rules: {}, isAircraft: () => false };
    const targeting = new WeaponTargeting(WeaponType.Primary, { isAntiAir: true, isAntiGround: true }, { damage: 25 }, {}, shooter, { prism: { type: 'ATESLA' } });
    const base: any = { owner, zone: ZoneType.Air, isTechno: () => true, isUnit: () => true, isInfantry: () => true };
    const enemy = { ...base, owner: {} };
    const alliances = { areFriendly: (a: any, b: any) => a.owner === b.owner, alliances: { haveSharedIntel: () => false } };
    const cases: [any, boolean, boolean, boolean][] = [
        [base, false, true, false], [base, true, false, true],
        [enemy, false, true, true],
        [{ ...enemy, cloakableTrait: { isCloaked: () => true } }, false, true, false],
        [{ ...enemy, warpedOutTrait: { isInvulnerable: () => true } }, false, true, false],
        [{ ...enemy, warpedOutTrait: { isInvulnerable: () => true } }, false, false, true],
    ];
    for (const [target, forcefire, shift, expected] of cases) {
        expect(targeting.canTarget(target, undefined, alliances, forcefire, shift)).toBe(expected);
        expect(targeting.canTarget(target, undefined, alliances, forcefire, shift)).toBe(baseline.call(targeting, target, undefined, alliances, forcefire, shift));
    }
});

test('inherited checks are visited while absent sparse slots are skipped', () => {
    const run = (method: any) => {
        const calls: string[] = [];
        const checks = [() => { calls.push('own'); return true; }, , , () => { calls.push('last'); return true; }];
        const inherited = Object.create(Array.prototype);
        inherited[1] = () => { calls.push('inherited'); return true; };
        Object.setPrototypeOf(checks, inherited);
        return { result: method.call({ targetChecks: checks }), calls };
    };
    expect(run(WeaponTargeting.prototype.canTarget)).toEqual(run(baseline));
    expect(run(WeaponTargeting.prototype.canTarget).calls).toEqual(['own', 'inherited', 'last']);
});
