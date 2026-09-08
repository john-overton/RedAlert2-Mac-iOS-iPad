import { expect, test } from 'bun:test';
import { GameElapsedTime } from './GameElapsedTime';
import { SidebarModel } from './viewmodel/SidebarModel';

test('elapsed clock follows simulation seconds, stays fixed during pauses, and supports hour rollover', () => {
    const game = { currentTime: 0 };
    const values: string[] = [];
    // Exercise frame updates without constructing WebGL resources.
    const timer = Object.create(GameElapsedTime.prototype);
    Object.assign(timer, {
        props: { sidebarModel: new SidebarModel(game) },
        text: { setValue: (value: string) => values.push(value) },
    });
    timer.onFrame();
    game.currentTime = 999;
    timer.onFrame();
    game.currentTime = 1000;
    timer.onFrame();
    for (let i = 0; i < 120; i++) timer.onFrame();
    game.currentTime = 3_599_999;
    timer.onFrame();
    game.currentTime = 3_600_000;
    timer.onFrame();
    expect(values).toEqual(['Time 0:00:00', 'Time 0:00:01', 'Time 0:59:59', 'Time 1:00:00']);
});
