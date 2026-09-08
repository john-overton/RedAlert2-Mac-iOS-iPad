import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessageFormat } from './ChatMessageFormat';
import { ChatRecipientType } from '@/network/chat/ChatMessage';

test('historical badges and player colors survive mutable lobby colors and safely escape names', () => {
    const colors = new Map([['<img src=x>', 'blue']]);
    const formatter = new ChatMessageFormat({get:(_key:string,value:string)=>value}, 'Local', colors);
    const message = {from:'<img src=x>',to:{type:ChatRecipientType.Channel,name:'#team'},time:new Date(),
        badge:{label:'Team 1',color:'#80cfff'},senderColor:'#ff0000'};
    colors.set(message.from,'green');
    const html=renderToStaticMarkup(<>{formatter.formatPrefixHtml(message)}{formatter.formatTextHtml('<script>alert(1)</script>',false)}</>);
    expect(html).toContain('[Team 1]');
    expect(html).toContain('color:#80cfff');
    expect(html).toContain('color:#ff0000');
    expect(html).not.toContain('color:green');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
});
