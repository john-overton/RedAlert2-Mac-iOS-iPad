import {expect,test} from 'bun:test';
import {GameServer} from '../server/GameServer';
import {HANDSHAKE_PROTOCOL,ORDERS_PROTOCOL,encodeOrderPacket,encodeSyncPacket, type StartGameMessage} from '../server/Protocol';
import type {ServerConnection,WireData} from '../server/ServerTransport';
import {EventDispatcher} from '@/util/event';
import {NetworkMatchSession} from './NetworkMatchSession';
import type {WebSocketConnection} from './WebSocketConnection';

class Link implements ServerConnection {
    remoteAddress='127.0.0.1'; messages:WireData[]=[];
    incoming:(data:WireData)=>void=()=>{}; closing:()=>void=()=>{};
    onServerMessage=new EventDispatcher<this,string|Uint8Array>();
    send(data:WireData){this.messages.push(data);this.onServerMessage.dispatch(this,data);}
    close(){this.closing();} onMessage(handler:(data:WireData)=>void){this.incoming=handler;} onClose(handler:()=>void){this.closing=handler;}
    json(message:unknown){this.incoming(JSON.stringify(message));}
    command(name:string,args:Record<string,unknown>={}){
        const session=this.all('session').at(-1)?.session??this.all('welcome').at(-1)?.session;
        this.json({type:'command',name,args:name==='observe'?{gameId:session?.gameId,generation:session?.generation,...args}:args});
    }
    all(type:string):any[]{return this.messages.filter((data):data is string=>typeof data==='string').map(data=>JSON.parse(data)).filter(message=>message.type===type);}
}
function setup(){
    const identity={protocol:HANDSHAKE_PROTOCOL,ordersProtocol:ORDERS_PROTOCOL,engine:'ra2' as const,mod:'base',version:'test',modHash:'rules',assetFingerprint:'retail'};
    const server=new GameServer({identity,dedicated:true,gameOpts:{gameSpeed:3,maxSlots:2,mapDigest:'digest',aiPlayers:[],humanPlayers:[],disconnectAi:true} as any});
    const join=(name:string,role:'player'|'observer'='player')=>{const peer=new Link();server.accept(peer);peer.json({...identity,type:'hello',name,role});return peer;};
    const a=join('Host'), b=join('Guest');a.command('map_ready',{digest:'digest'});b.command('state',{ready:true,mapDigest:'digest'});a.command('startgame');
    const start:StartGameMessage=a.all('startGame')[0];
    for(const peer of[a,b])peer.json({type:'loaded',gameId:start.gameId,generation:start.generation,percent:100});
    return{server,a,b,join,start};
}

test('real archive and observer retain departed commander orders before applying the scheduled AI drop',()=>{
    const{server,a,b,join,start}=setup();
    let match:NetworkMatchSession|undefined;
    try{
        const generation=start.generation;
        a.incoming(encodeOrderPacket(1,1,new Uint8Array([42]),generation));
        b.incoming(encodeOrderPacket(2,1,new Uint8Array([43]),generation));
        a.incoming(encodeSyncPacket(1,10,0n,generation));
        // Host has computed frame1, guest exits without sending its final sync.
        b.json({type:'returnToLobby',gameId:start.gameId,generation,reason:'forfeit'});
        for(let frame=2;frame<=4;frame++){
            a.incoming(encodeOrderPacket(1,frame,new Uint8Array([40+frame]),generation));
            a.incoming(encodeSyncPacket(frame,frame*10,frame===4?2n:0n,generation));
        }
        const observer=join('Watcher','observer');observer.command('map_ready',{digest:'digest'});observer.command('observe');
        const observe:StartGameMessage=observer.all('startGame')[0];
        expect(observe.clientIds).toEqual([1,2]);expect(observe.humanAssignments).toEqual(start.humanAssignments);
        const sent:unknown[]=[];
        const connection={onMessage:observer.onServerMessage,onClose:new EventDispatcher<any,string>(),close(){},
            sendImmediate(message:unknown){sent.push(message);observer.json(message);},sendRaw(){throw new Error('Observer sent gameplay packet');}};
        match=new NetworkMatchSession(connection as unknown as WebSocketConnection,observe,{kind:'lan',observer:true,roomId:start.gameId,gameId:start.gameId,timestamp:start.timestamp,
            hostPeerId:'1',localPeerId:'3',localPlayerName:'Watcher',gameOpts:observe.gameOpts,humanAssignments:observe.humanAssignments.map(item=>({peerId:String(item.clientId),slotIndex:item.slotIndex,name:item.name})),mapTransferStateByPeerId:{},returnRoute:{screenType:0}});
        match.reportLoadProgress(100);
        for(let tick=0;tick<4;tick++){
            const turn=match.tryConsumeTurn(tick);expect(turn).toBeDefined();
            expect(turn!.dropPeerIds).toEqual(tick===3?['2']:[]);
            if(tick===2)expect(turn!.batches.map(batch=>[...batch.actionData])).toEqual([[42],[43]]);
            match.sendSync(tick,(tick+1)*10,tick===3?2n:0n);
        }
        expect(match.fatalError).toBeUndefined();expect(match.takesOverWithAi('2')).toBe(true);
        expect(sent).toHaveLength(1);expect(observer.messages.some(data=>data instanceof Uint8Array)).toBe(false);
        expect(server.session.state).toBe('started');
    }finally{match?.dispose();server.stop();}
});

test('history gaps and duplicate consumed cursors fail only the observer and old cancellation cannot stop its retry',()=>{
    const{server,a,b,join,start}=setup();
    try{
        a.incoming(encodeSyncPacket(1,10,0n,start.generation));b.incoming(encodeSyncPacket(1,10,0n,start.generation));
        const o=join('Watcher','observer');o.command('map_ready',{digest:'digest'});o.command('observe');
        const first=o.all('startGame')[0];
        const pull=(fromFrame:number,observationId=first.observationId)=>o.json({type:'history',gameId:start.gameId,generation:start.generation,observationId,fromFrame});
        pull(2);expect(o.all('error').at(-1).message).toContain('cursor');expect(o.all('history')).toHaveLength(0);
        pull(1);expect(o.all('history')).toHaveLength(1);pull(1);expect(o.all('history')).toHaveLength(1);
        o.json({type:'returnToLobby',gameId:start.gameId,generation:start.generation,observationId:first.observationId,reason:'finished'});
        o.command('observe');const second=o.all('startGame').at(-1);
        o.json({type:'returnToLobby',gameId:start.gameId,generation:start.generation,observationId:first.observationId,reason:'finished'});
        pull(1,second.observationId);expect(o.all('history')).toHaveLength(2);
        expect(server.session.state).toBe('started');expect(a.all('error')).toEqual([]);expect(b.all('error')).toEqual([]);
    }finally{server.stop();}
});
