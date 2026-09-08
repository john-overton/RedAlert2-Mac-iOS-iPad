import { expect, test } from 'bun:test';
import { EventDispatcher } from '@/util/event';
import { ChatRecipientType } from '@/network/chat/ChatMessage';
import { RECIPIENT_ALL, RECIPIENT_TEAM } from '@/network/gservConfig';
import { NetworkChatHandler, chatBadge } from './NetworkChatHandler';

function fixture(observer = false) {
    const sent: unknown[] = [], hud: unknown[] = [], history: unknown[] = [], replay: unknown[] = [];
    const muted = new Set<string>();
    const match = { isObserver: () => observer, onChat: new EventDispatcher<any, any>(), start: {humanAssignments:[{clientId:1,name:'Alice'},{clientId:2,name:'Bob'}]}, sendChat: (...args: unknown[]) => sent.push(args) };
    const handler = new NetworkChatHandler(match as any, {addChatMessage:(...args:unknown[])=>hud.push(args)}, {addChatMessage:(message:unknown)=>history.push(message)},
        {formatPrefixPlain:(message:any)=>message.from}, {currentTick:123,rules:{getMultiplayerColors:()=>new Map([[0,{asHexString:()=>'red'}]])}},
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
    const receive = (to: string) => f.match.onChat.dispatch(f.match,{type:'chat',clientId:2,to,text:'Hello',sender:{name:'Bob',colorId:0,teamId:0}});
    receive('all'); receive('team');
    expect(f.hud).toEqual([['Bob: Hello','red',{label:'All',color:'#dddddd'}],['Bob: Hello','red',{label:'Team 1',color:'#80cfff'}]]);
    expect(f.history).toHaveLength(2);
    expect(f.replay).toEqual([[123,'Bob','Hello']]);
    f.muted.add('Bob'); receive('all');
    expect(f.hud).toHaveLength(2);
    f.muted.clear(); f.handler.dispose(); receive('all');
    expect(f.hud).toHaveLength(2);
});


test('observer composer only submits to observers', () => {
    const f = fixture(true);
    for (const name of [RECIPIENT_ALL, RECIPIENT_TEAM, 'Bob', '#observers']) f.handler.submitMessage('Hello', {type:ChatRecipientType.Channel,name});
    f.handler.submitMessage('Private', {type:ChatRecipientType.Whisper,name:'Bob'});
    expect(f.sent).toEqual([['observers','Hello']]);
});

test('server identities and badges survive departed observers and team changes', () => {
    const f = fixture(true);
    const sender = {name:'Departed <observer>',colorId:-2,teamId:-3};
    f.match.onChat.dispatch(f.match,{type:'chat',clientId:9,to:'observers',text:'<img src=x>',sender});
    sender.name = 'Changed'; sender.teamId = 2;
    expect(f.history[0]).toMatchObject({from:'Departed <observer>',sender:{name:'Departed <observer>',teamId:-3},badge:{label:'Observers'}});
    expect(f.hud[0]).toEqual(['Departed <observer>: <img src=x>','#ffffff',{label:'Observers',color:'#c6a0e8'}]);
    expect(f.replay).toEqual([]);
});

test('team badges label unteamed players and have stable per-team colors', () => {
    expect(chatBadge('team', -2)?.label).toBe('No team');
    expect(chatBadge('team', 0)?.label).toBe('Team 1');
    expect(chatBadge('team', 1)?.color).not.toBe(chatBadge('team', 0)?.color);
    expect(chatBadge(2, 0)).toBeUndefined();
});
