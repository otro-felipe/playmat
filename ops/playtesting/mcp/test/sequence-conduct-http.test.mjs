import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketServer } from 'ws';
import { PlaymatEngineSeat } from '../src/engine-seat.mjs';
import { createMcpServer } from '../src/server.mjs';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const gameId=id(1), own=id(2), rival=id(3), bolt=id(4), shock=id(5), boltStack=id(6), shockStack=id(7);
const card = (cardId, name) => ({ id:cardId, cardId, name, cardTypes:['INSTANT'], controllerId:own });
const boltCard=card(bolt,'Lightning Bolt'), shockCard=card(shock,'Shock');
async function fixture(t, variant) {
  const ws = new WebSocketServer({ host:'127.0.0.1', port:0 }); await once(ws,'listening');
  const accepted=[], timers=new Set();
  let seq=0, counter=0, revision=0, turn=3, active=own, life=20, stack={}, hand={ [bolt]:boltCard,[shock]:shockCard }, resolutions={};
  const engine=new PlaymatEngineSeat({ engineUrl:`ws://127.0.0.1:${ws.address().port}`, engineName:'Pilot',trustedHeader:'X-Fixture' });
  const server=createMcpServer({ authorize:async token=>token==='isolated-http-fixture'?{accountId:'fixture',engineName:'Pilot',scopes:['play']}:null,createEngine:()=>engine });
  const connected=once(ws,'connection');
  let send;
  const view=()=>({ turn,phase:'PRECOMBAT_MAIN',step:variant==='advance'?'END_TURN':'PRECOMBAT_MAIN',myPlayerId:own,activePlayerId:active,activePlayerName:active===own?'Pilot':'Rival',priorityPlayerName:'Pilot',
    players:[{playerId:own,name:'Pilot',hasPriority:true,battlefield:{}},{playerId:rival,name:'Rival',life,battlefield:{}}],myHand:hand,stack,
    sequenceEvidence:{epoch:'synthetic-feed',publicActions:{[own]:0,[rival]:counter},resolutions,resolutionRevision:revision},
    canPlayObjects:{objects:Object.fromEntries(Object.keys(hand).map(id=>[id,{}]))} });
  const next=(method='GAME_SELECT',message='Play spells and abilities')=>send(method,{message,gameView:view(), ...(method==='GAME_TARGET'?{targets:[rival],flag:true}:{})});
  ws.on('connection',socket=>{
    send=(method,data)=>socket.send(JSON.stringify({method,messageId:++seq,objectId:gameId,data}));
    socket.on('message',raw=>{
      const {method,id:requestId,params}=JSON.parse(raw);
      socket.send(JSON.stringify({jsonrpc:'2.0',id:requestId,result:method==='serverGetMainRoomId'?gameId:true}));
      if(!['sendPlayerUUID','sendPlayerBoolean'].includes(method))return;
      accepted.push({method,value:params[2]});
      const timer=setTimeout(()=>{
        timers.delete(timer);
        if(variant==='advance'){turn++;active=own;hand={};next();return;}
        if(method==='sendPlayerUUID'){
          const physical=params[2], physicalCard=physical===bolt?boltCard:shockCard;
          delete hand[physical];stack={[physical===bolt?boltStack:shockStack]:{...physicalCard,id:physical===bolt?boltStack:shockStack}};next();
        }else{
          const resolving=Object.keys(stack)[0];resolutions={...resolutions,[resolving]:++revision};life-=resolving===boltStack?3:2;stack={};
          if(variant==='opponent-action')counter++;
          if(variant==='unexpected-target')next('GAME_TARGET','Choose an unplanned target');else next();
        }
      },5);timers.add(timer);
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=new Client({name:'sequence-conduct-http',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer isolated-http-fixture'}}}));
  t.after(async()=>{for(const timer of timers)clearTimeout(timer);await client.close();engine.close();for(const s of ws.clients)s.terminate();ws.close();server.closeAllConnections();server.close();});
  const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});const data=JSON.parse(r.content[0].text);assert.equal(r.isError??false,false,JSON.stringify(data));return data;};
  await engine.open();await connected;send('START_GAME',{gameId,playerId:own});send('GAME_INIT',view());next();
  const ready=await call('wait_for_decision',{gameId,timeoutMs:500});
  return{call,accepted,initial:ready.state};
}
for(const variant of ['own-damage','opponent-action','unexpected-target'])test(`HTTP+WebSocket causal sequence boundary: ${variant}`,async(t)=>{
  const f=await fixture(t,variant);
  const plan=await f.call('play_sequence',{gameId,cursor:f.initial.cursor,steps:[
    {kind:'answer',select:{cardId:bolt,zone:'hand'},guard:{kind:'priority',priority:'self'},expectCast:true},
    {kind:'yield_priority',allowPlannedResolutions:true},
    {kind:'answer',select:{cardId:shock,zone:'hand'},guard:{kind:'priority',priority:'self'},expectCast:true},
    {kind:'yield_priority',allowPlannedResolutions:true},
  ]});
  let result;for(let i=0;i<60;i++){result=await f.call('get_sequence_status',{gameId,sequenceId:plan.sequenceId});if(result.status!=='running')break;await sleep(5);}
  assert.equal(result.status,variant==='own-damage'?'completed':'interrupted');
  assert.equal(result.appliedDecisions,variant==='own-damage'?4:2);
  assert.equal(f.accepted.length,variant==='own-damage'?4:2);
  if(variant==='own-damage'){const s=await f.call('get_game_state',{gameId});assert.equal(s.players.find(p=>p.id===rival).life,15);assert.equal(s.sequenceEvidence.resolutionRevision,2);}
});
test('HTTP MCP discovery exposes explicit advance and brief pacing without removing legacy tools',async(t)=>{
  const f=await fixture(t,'advance');
  const state=await f.call('get_game_state',{gameId});
  assert.equal(state.activePlayerId,own);assert.equal(state.sequenceEvidence.epoch,'synthetic-feed');
  const paced=await f.call('play_sequence',{gameId,cursor:state.cursor,steps:[{kind:'pace',delayMs:1}]});
  for(let i=0;i<30;i++){const r=await f.call('get_sequence_status',{gameId,sequenceId:paced.sequenceId});if(r.status!=='running'){assert.equal(r.status,'completed');assert.ok(r.effectiveDelayMs<=1);return;}await sleep(3);}
  assert.fail('Pacing must terminate');
});
