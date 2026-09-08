import { expect, test } from 'bun:test';
import { EventDispatcher } from '@/util/event';
import { ChatRecipientType } from '@/network/chat/ChatMessage';
import { RECIPIENT_ALL, RECIPIENT_TEAM } from '@/network/gservConfig';
import { NetworkChatHandler } from './NetworkChatHandler';

function fixture() {
    const sent: unknown[] = [], hud: unknown[] = [], history: unknown[] = [], replay: unknown[] = [];
    const muted = new Set<string>();
    const match = { onChat: new EventDispatcher<any, any>(), start: {humanAssignments:[{clientId:1,name:'Alice'},{clientId:2,name:'Bob'}]}, sendChat: (...args: unknown[]) => sent.push(args) };
    const handler = new NetworkChatHandler(match as any, {addChatMessage:(...args:unknown[])=>hud.push(args)}, {addChatMessage:(message:unknown)=>history.push(message)},
        {formatPrefixPlain:(message:any)=>message.from}, {currentTick:123,getPlayerByName:()=>({color:{asHexString:()=>'red'}})},
        {recordChatMessage:(...args:unknown[])=>replay.push(args)}, muted);
    handler.init();
    return {handler,match,sent,hud,history,replay,muted};
}

test('direct chat routes all, team and named whispers without echoing before the server', () => {
    const f = fixture();
    f.handler.submitMessage('Hello', {type:ChatRecipientType.Channel,name:RECIPIENT_ALL});
    f.handler.submitMessage('Team', {type:ChatRecipientType.Channel,name:RECIPIENT_TEAM});
    f.handler.submitMessage('Private', {type:ChatRecipientType.Whisper,name:'Bob'});
    f.handler.submitMessage('Unknown', {type:ChatRecipientType.Whisper,name:'Nobody'});
    f.handler.submitMessage('  ', {type:ChatRecipientType.Channel,name:RECIPIENT_ALL});
    expect(f.sent).toEqual([['all','Hello'],['team','Team'],[2,'Private']]);
    expect(f.hud).toHaveLength(0);
});

test('received chat updates HUD/history, records only public messages and honors mute/disposal', () => {
    const f = fixture();
    const receive = (to: string) => f.match.onChat.dispatch(f.match,{type:'chat',clientId:2,to,text:'Hello'});
    receive('all'); receive('team');
    expect(f.hud).toEqual([['Bob Hello','red'],['Bob Hello','red']]);
    expect(f.history).toHaveLength(2);
    expect(f.replay).toEqual([[123,'Bob','Hello']]);
    f.muted.add('Bob'); receive('all');
    expect(f.hud).toHaveLength(2);
    f.muted.clear(); f.handler.dispose(); receive('all');
    expect(f.hud).toHaveLength(2);
});
