import { expect, test } from 'bun:test';
import { Pointer } from '../gui/Pointer';
import { BoxedVar } from '../util/BoxedVar';

test('the game cursor remains visible over the canvas without pointer lock', () => {
    let visible = false;
    const canvas = {style:{cursor:''}};
    const sprite = {setVisible:(value:boolean)=>visible=value,getSize:()=>({width:30,height:30}),setPosition:()=>{}};
    const metrics = {width:800,height:600,toCanvasPosition:(x:number,y:number)=>({x,y})};
    const pointer = new Pointer({isActive:()=>false} as any,sprite as any,{} as any,canvas as any,metrics as any,new BoxedVar(false)) as any;
    pointer.onMouseMove({target:canvas,pageX:120,pageY:80});
    expect(visible).toBe(true);
    expect(canvas.style.cursor).toBe('none');
    pointer.onMouseMove({target:{},pageX:120,pageY:80});
    expect(visible).toBe(false);
    expect(canvas.style.cursor).toBe('');
    pointer.onMouseMove({target:canvas,pageX:120,pageY:80});
    pointer.setVisible(false);
    expect(visible).toBe(false);
    pointer.setVisible(true);
    expect(visible).toBe(true);
    pointer.leaveCanvas();
    expect(visible).toBe(false);
});
