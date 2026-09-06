import { expect, test } from 'bun:test';
import { Replay } from '../network/gamestate/Replay';
import { ReplayRecorder } from '../network/gamestate/ReplayRecorder';
import { ReplayTurnManager } from '../network/gamestate/ReplayTurnManager';
import { BoxedVar } from '../util/BoxedVar';
import { ActionType } from '../game/action/ActionType';

test('recording preserves empty selection actions across storage', () => {
    const replay = new Replay();
    replay.gameOpts = {mapName:'all01t.map',mapDigest:'digest'};
    const recorder = new ReplayRecorder({}, replay);
    recorder.recordActions(25,[{player:{index:0},actionType:ActionType.SelectUnits,serialize:()=>new Uint8Array()}]);
    const restored = new Replay();
    restored.unserialize(replay.serialize());
    expect(restored.actionRecords).toEqual([{tick:25,playerId:0,actionType:ActionType.SelectUnits,data:new Uint8Array()}]);
    expect(restored.gameOpts.mapDigest).toBe('digest');
});

test('replay checks pre-action state and stops at the saved tick', () => {
    const observedTicks: number[] = [];
    const game = {currentTick:0, speed:new BoxedVar(1),desiredSpeed:new BoxedVar(1),
        update(){this.currentTick++;},getHash(){observedTicks.push(this.currentTick);return this.currentTick;}};
    const turn = new ReplayTurnManager(game,{finishedTick:2,hashCheckpoints:[{tick:0,hash:0},{tick:1,hash:1}]},{});
    turn.init();
    turn.doGameTurn(0);turn.doGameTurn(1);turn.doGameTurn(2);
    expect(game.currentTick).toBe(2);
    expect(observedTicks).toEqual([0,1]);
    expect(turn.isFinished()).toBe(true);
    turn.dispose();
});
