import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HudChat } from './HudChat';
import { ChatRecipientType } from '@/network/chat/ChatMessage';

function render(observerChat: boolean, recipient: {type:ChatRecipientType;name:string}) {
    return renderToStaticMarkup(<HudChat isComposing messageList={{observerChat,getRecentChatMessages:()=>[]}}
        chatHistory={{lastComposeTarget:{value:recipient},lastWhisperFrom:{value:'Opponent'}}}
        strings={{get:(key:string)=>key}} onSubmit={()=>{}} onCancel={()=>{}}/>);
}
test('observer HUD rejects remembered whispers and player channels at the composer boundary', () => {
    for (const recipient of [{type:ChatRecipientType.Channel,name:'#team'},{type:ChatRecipientType.Whisper,name:'Opponent'}]) {
        const html=render(true,recipient);
        expect(html).toContain('To Observers:');
        expect(html).toContain('Observers only');
        expect(html).not.toContain('TS:ToAllies');
    }
});
test('commander HUD falls back from observer channel and keeps audience cycling', () => {
    const html=render(false,{type:ChatRecipientType.Channel,name:'#observers'});
    expect(html).toContain('TS:ToAll');
    expect(html).toContain('Tab to change audience');
    expect(html).not.toContain('To Observers:');
});
