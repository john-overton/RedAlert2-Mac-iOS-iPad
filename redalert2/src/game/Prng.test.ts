import { expect, test } from 'bun:test';
import MersenneTwister from 'mersenne-twister';
import { Prng } from './Prng';

test('fresh generators expose a finite zero sentinel with stable hash bytes', () => {
    for (const generator of [new Prng(12345), Prng.factory('mass-unit-benchmark', 1757000000000), Prng.factory(12345, 7)]) {
        expect(generator.getLastRandom()).toBe(0);
        expect(Number.isFinite(generator.getLastRandom())).toBe(true);
        expect(Array.from(new Uint8Array(new Float64Array([generator.getLastRandom()]).buffer))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    }
});

for (const seed of [0, 1, 12345, 0xffffffff]) {
    test(`initialization and reads preserve the original random sequence for seed ${seed}`, () => {
        const generator = new Prng(seed);
        const reference = new MersenneTwister(seed);
        // Reading the sentinel repeatedly must not consume any random draws.
        for (let i = 0; i < 10; i++) expect(generator.getLastRandom()).toBe(0);
        for (let i = 0; i < 100; i++) {
            const expected = reference.random();
            if (i % 2 === 0) {
                expect(generator.generateRandom()).toBe(expected);
            } else {
                const min = -10;
                const max = 37;
                expect(generator.generateRandomInt(min, max)).toBe(Math.floor(expected * (max - min + 1)) + min);
            }
            // Integer draws retain the underlying uniform sample, not the integer.
            expect(generator.getLastRandom()).toBe(expected);
            expect(generator.getLastRandom()).toBe(expected);
        }
    });
}

test('single-value integer ranges still consume exactly one random draw', () => {
    const generator = new Prng(42);
    const reference = new MersenneTwister(42);
    expect(generator.generateRandomInt(7, 7)).toBe(7);
    expect(generator.getLastRandom()).toBe(reference.random());
    expect(generator.generateRandom()).toBe(reference.random());
});
