import {expect,spyOn,test} from 'bun:test';
import {GameAnimationLoop} from './GameAnimationLoop';

function fixture(advance?:()=>boolean){
    let frame=0;const suppressed:boolean[]=[];const interpolations:number[]=[];
    const sound={gameplaySuppressed:false,audioSystem:{setMuted(){}}};
    const renderer={getStats(){return null;},update(_time:number,interpolation:number){interpolations.push(interpolation);},render(){},flush(){}};
    const manager={getTurnMillis(){return 33;},doGameTurn(){suppressed.push(sound.gameplaySuppressed);frame++;return advance?.()??true;},setErrorState(){}};
    const loop=new GameAnimationLoop({isObserver:true},renderer,sound,manager,{isCatchingUp:()=>frame<5,skipBudgetMillis:8});
    (loop as any).isStarted=true;
    return{loop,sound,suppressed,interpolations,getFrame:()=>frame};
}
test('accelerated observer ticks suppress audio and resume rendering with finite interpolation',()=>{
    const old=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=()=>1;
    const now=spyOn(performance,'now').mockReturnValue(0);
    try{
        const{loop,sound,suppressed,interpolations,getFrame}=fixture();
        (loop as any).turnMgrIsWaiting=true;
        (loop as any).doFrame(1000);
        expect(getFrame()).toBe(5);expect(suppressed).toEqual([true,true,true,true,true]);
        expect(sound.gameplaySuppressed).toBe(false);expect(interpolations).toHaveLength(1);expect(Number.isFinite(interpolations[0])).toBe(true);
        (loop as any).doFrame(1033);expect(getFrame()).toBe(6);expect(suppressed.at(-1)).toBe(false);
    }finally{now.mockRestore();globalThis.requestAnimationFrame=old;}
});
test('catchup yields at the frame gap and clears audio suppression on errors',()=>{
    const now=spyOn(performance,'now').mockReturnValue(0);
    try{
        const stalled=fixture(()=>false);(stalled.loop as any).advanceCatchup(1000);
        expect(stalled.getFrame()).toBe(1);expect(stalled.sound.gameplaySuppressed).toBe(false);
        const error=fixture(()=>{throw new Error('simulation failed');});
        expect(()=>(error.loop as any).advanceCatchup(1000)).toThrow('simulation failed');expect(error.sound.gameplaySuppressed).toBe(false);
    }finally{now.mockRestore();}
});
test('catchup respects the CPU budget instead of draining an unbounded backlog',()=>{
    let elapsed=0;const now=spyOn(performance,'now').mockImplementation(()=>elapsed+=3);
    try{const{loop,getFrame,sound}=fixture();(loop as any).advanceCatchup(1000);expect(getFrame()).toBe(2);expect(sound.gameplaySuppressed).toBe(false);}
    finally{now.mockRestore();}
});
