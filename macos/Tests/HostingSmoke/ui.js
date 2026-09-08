// Executed inside a native WKWebView using the built game and the production bridge.
const until = async (check, label) => {
    const deadline=Date.now()+240000;
    while(!check()) {
        const error=document.querySelector('[role=alert]');
        if(error?.textContent)throw Error(error.textContent);
        if(Date.now()>deadline)throw Error('Timed out: '+label+'; '+document.body.innerText.slice(-1000));
        await new Promise(resolve=>setTimeout(resolve,100));
    }
};
const textElement = text => [...document.querySelectorAll('body *')].find(el=>el.textContent===text && el.children.length===0 && el.getBoundingClientRect().width);
await until(()=>textElement('Multiplayer'),'main menu');
textElement('Multiplayer').click();
await until(()=>document.querySelector('.multiplayer-entry'),'multiplayer form');
const fill=(label,value)=>{
    const input=[...document.querySelectorAll('label')].find(el=>el.textContent.trim()===label)?.querySelector('input');
    if(!input)throw Error('Missing field '+label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));
};
fill('Player name','Mac UI Host');fill('Port','19722');
const bridge=window.__RA2_SHELL__;
const realHost=bridge.hostGame;
let options;
bridge.hostGame=async value=>{options=value;return realHost(value)};
const create=document.querySelector('.multiplayer-entry button[type=submit]');
if(create.disabled)throw Error('Native Create Game is disabled');
create.click();
await until(()=>document.querySelector('.multiplayer-lobby'),'host lobby');
const recoverAt=Date.now()+16000;
const guest=await new Promise((resolve,reject)=>{
    const socket=new WebSocket('ws://127.0.0.1:19722');
    socket.onopen=()=>socket.send(JSON.stringify({...options.identity,type:'hello',name:'Native UI Guest',password:options.password}));
    socket.onerror=()=>reject(Error('Guest WebSocket failed'));
    socket.onmessage=event=>{
        const message=JSON.parse(event.data);
        if(message.type==='welcome')resolve(socket);
        if(message.type==='error')reject(Error(JSON.stringify(message)));
        if(message.type==='ping')setTimeout(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'pong',t:message.t}));},Math.max(0,recoverAt-Date.now()));
    };
});
await until(()=>textElement('Native UI Guest'),'guest in host lobby');
await until(()=>[...document.querySelectorAll('.mp-ping')].some(el=>el.textContent.includes('Native UI Guest')&&el.textContent.includes('No reply')),'slow guest warning');
await until(()=>[...document.querySelectorAll('.mp-ping')].some(el=>el.textContent.includes('Native UI Guest')&&/\d+ ms/.test(el.textContent)&&!el.textContent.includes('No reply')),'delayed heartbeat recovery and ping display');
if(!document.querySelector('.multiplayer-lobby'))throw Error('Delayed pongs disconnected the lobby');
const closed=new Promise(resolve=>guest.onclose=resolve);
textElement('Leave Game').click();
await closed;
await until(()=>document.querySelector('.multiplayer-entry'),'return to create/join');
document.querySelector('.multiplayer-entry button[type=submit]').click();
await until(()=>document.querySelector('.multiplayer-lobby'),'rehost on same port');
textElement('Leave Game').click();
await until(()=>document.querySelector('.multiplayer-entry'),'final leave');
return 'Native game UI: Create Game enabled, host lobby, guest join, ping display, 16-second heartbeat stall/recovery, Leave Game and same-port rehost passed';
