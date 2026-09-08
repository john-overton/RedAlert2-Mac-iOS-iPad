import { WeaponTargeting } from '../../redalert2/src/game/WeaponTargeting';
import { ZoneType } from '../../redalert2/src/game/gameobject/unit/ZoneType';
import { performance } from 'node:perf_hooks';

// Exact pre-change forwarding method; all predicates come from the real class.
function baseline(this: any, target?: any, context?: any, alliances?: any, forcefire?: boolean, shift?: boolean): boolean {
    return this.targetChecks.every((check: any) => check(target, context, alliances, forcefire, shift));
}
// Rejected production candidate, retained only for reproducible diagnostics.
function indexed(this: any, target?: any, context?: any, alliances?: any, forcefire?: boolean, shift?: boolean): boolean {
    const checks = this.targetChecks;
    const length = checks.length;
    for (let index = 0; index < length; index++) {
        if (!(index in checks)) continue;
        const check = checks[index];
        if (!check(target, context, alliances, forcefire, shift)) return false;
    }
    return true;
}
const shooter: any = { name: 'JUMPJET', rules: {}, owner: { id: 1 } };
const targeting = new WeaponTargeting(0, { isAntiAir: true, isAntiGround: true }, { damage: 25 }, {}, shooter, { prism: { type: 'ATESLA' } });
const friendly = { ...shooter, zone: ZoneType.Air, isTechno: () => true, isUnit: () => true, isInfantry: () => true };
const enemy = { ...friendly, owner: { id: 2 } };
const cloakedEnemy = { ...enemy, cloakableTrait: { isCloaked: () => true } };
const invulnerable = { ...enemy, warpedOutTrait: { isInvulnerable: () => true } };
const alliances = { areFriendly: (a: any, b: any) => a.owner === b.owner, alliances: { haveSharedIntel: () => false } };
const cases = {
    mostlyFriendly: Array.from({ length: 1000 }, (_, i) => i % 100 === 0 ? enemy : friendly),
    mixed: [friendly, enemy, cloakedEnemy, invulnerable],
    enemy: [enemy],
};
function verify(fn: any) {
    const fixtureResults = Object.values(cases).map(candidates => candidates.map(candidate => fn.call(targeting, candidate, {}, alliances, false, true)));
    const orders: any[] = [];
    for (const mutation of ['none', 'stop', 'delete', 'append', 'replace']) {
        const calls: string[] = [];
        const probe: any = { targetChecks: [] };
        probe.targetChecks.push(() => {
            calls.push('first');
            if (mutation === 'delete') delete probe.targetChecks[1];
            if (mutation === 'append') probe.targetChecks.push(() => { calls.push('appended'); return true; });
            if (mutation === 'replace') probe.targetChecks[1] = () => { calls.push('replaced'); return true; };
            return mutation !== 'stop';
        }, () => { calls.push('second'); return true; });
        orders.push({ mutation, result: fn.call(probe), calls });
    }
    return { fixtureResults, orders };
}
if (JSON.stringify(verify(baseline)) !== JSON.stringify(verify(indexed))) throw new Error('predicate behavior mismatch');
const contexts: any = {};
const shooterPool = Array.from({ length: 1000 }, () => new WeaponTargeting(0, { isAntiAir: true, isAntiGround: true }, { damage: 25 }, {}, { ...shooter }, { prism: { type: 'ATESLA' } }));
const samples: any[] = [];
for (const distinctShooters of [1, 1000]) {
for (const [name, candidates] of Object.entries(cases)) {
    const run = (fn: any) => {
        let accepted = 0;
        const start = performance.now();
        for (let i = 0; i < 1_000_000; i++) accepted += Number(fn.call(shooterPool[i % distinctShooters], candidates[i % candidates.length], contexts, alliances, false, true));
        return { ms: performance.now() - start, accepted };
    };
    for (let i = 0; i < 8; i++) { run(baseline); run(indexed); }
    const baselineSamples: any[] = [], indexedSamples: any[] = [];
    for (let repeat = 0; repeat < 11; repeat++) {
        if (repeat % 2) { indexedSamples.push(run(indexed)); baselineSamples.push(run(baseline)); }
        else { baselineSamples.push(run(baseline)); indexedSamples.push(run(indexed)); }
    }
    const median = (items: any[]) => items.map(item => item.ms).sort((a,b) => a-b)[5];
    samples.push({name, distinctShooters, callsPerSample: 1_000_000, baselineSamples, indexedSamples, baselineMedianMs: median(baselineSamples), indexedMedianMs: median(indexedSamples)});
}
}
console.log(JSON.stringify({runtime: `Bun ${Bun.version}`, diagnostic: 'Real WeaponTargeting predicates, synthetic target fixtures; baseline forwarding method versus rejected indexed prototype. Interleaved 11 repeats after 8 warmups.', correctness: verify(indexed).orders, samples}, null, 2));
