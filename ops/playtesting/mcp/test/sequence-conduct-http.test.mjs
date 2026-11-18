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
const levelText='{3}{U}: Level 2';
async function fixture(t, variant) {
  const ws = new WebSocketServer({ host:'127.0.0.1', port:0 }); await once(ws,'listening');
  const accepted=[], timers=new Set();
  let seq=0, counter=0, revision=0, turn=3, active=own, life=20, stack={}, hand={ [bolt]:boltCard,[shock]:shockCard }, resolutions={};
  if(variant==='opt-terminal')hand[bolt]={...boltCard,name:'Opt',rules:['Scry 1. Draw a card.']};
  const classVariant=variant==='class-activation'||variant==='class-hidden-ability';
  const classCard={...boltCard,name:variant==='class-hidden-ability'?'Hidden secret source':"Stormchaser's Talent",cardTypes:['ENCHANTMENT'],rules:[levelText],...(variant==='class-hidden-ability'?{faceDown:true}:{})};
  const classStack={id:boltStack,name:'Ability',controllerId:own,abilityType:'ACTIVATED_NONMANA',rules:[levelText],sourceCard:classCard};
  if(classVariant)hand={};
  if(variant==='class-hidden-ability')stack={[boltStack]:classStack};
  if (variant === 'existing-stack') { delete hand[bolt]; stack = { [boltStack]: { ...boltCard, id: boltStack } }; }
  if (variant === 'library-boundary') delete hand[shock];
  const engine=new PlaymatEngineSeat({ engineUrl:`ws://127.0.0.1:${ws.address().port}`, engineName:'Pilot',trustedHeader:'X-Fixture' });
  const server=createMcpServer({ authorize:async token=>token==='isolated-http-fixture'?{accountId:'fixture',engineName:'Pilot',scopes:['play']}:null,createEngine:()=>engine });
  const connected=once(ws,'connection');
  let send;
  const view=()=>({ turn,phase:'PRECOMBAT_MAIN',step:variant==='advance'?'END_TURN':'PRECOMBAT_MAIN',myPlayerId:own,activePlayerId:active,activePlayerName:active===own?'Pilot':'Rival',priorityPlayerName:'Pilot',
    players:[{playerId:own,name:'Pilot',hasPriority:true,battlefield:classVariant?{[bolt]:classCard}:{}},{playerId:rival,name:'Rival',life,battlefield:{}}],myHand:hand,stack,
    ...(variant==='library-boundary'?{lookedAt:[{name:'Previously observed top card',cards:{[shock]:{id:shock,expansionSetCode:'M11',cardNumber:'153'}}}]}:{}),
    sequenceEvidence:{epoch:'synthetic-feed',publicActions:{[own]:0,[rival]:counter},resolutions,resolutionRevision:revision,combatRevision:0,combatDamage:[],informationRevision:0},
    canPlayObjects:{objects:Object.fromEntries((classVariant?[bolt]:Object.keys(hand)).map(id=>[id,{}]))} });
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
          if(classVariant){stack={[boltStack]:classStack};next();return;}
          const physical=params[2], physicalCard=physical===bolt?boltCard:shockCard;
          delete hand[physical];stack={[physical===bolt?boltStack:shockStack]:{...physicalCard,id:physical===bolt?boltStack:shockStack}};next();
        }else{
          const resolving=Object.keys(stack)[0];resolutions={...resolutions,[resolving]:++revision};life-=classVariant?0:resolving===boltStack?3:2;stack={};
          if(variant==='opponent-action')counter++;
          if(variant==='library-boundary')send('GAME_TARGET',{message:'Select a card to PUT on the BOTTOM of your library (Scry)',gameView:view(),targets:[shock],cardsView1:{[shock]:shockCard},options:{targetZone:'LIBRARY'},flag:false});
          else if(variant==='random-boundary')send('GAME_ASK',{message:'Choose which flip to keep',gameView:view()});
          else if(variant==='unexpected-target')next('GAME_TARGET','Choose an unplanned target');else next();
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
  return{call,client,accepted,initial:ready.state};
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
test('[PM-AC-09-RESPONSES] Class activated metadata survives the real HTTP/WebSocket projection and resolves its exact forecast',async(t)=>{
  const f=await fixture(t,'class-activation');
  const plan=await f.call('play_turn',{gameId,cursor:f.initial.cursor,actions:[{kind:'choose',select:{cardId:bolt,zone:'battlefield'},guard:{kind:'priority'},expectAbility:{sourceId:bolt,abilityText:levelText}}],finish:'none'});
  let result;
  for(let n=0;n<80;n++){result=await f.call('get_sequence_status',{gameId,sequenceId:plan.sequenceId});if(result.status!=='running')break;await sleep(5);}
  assert.equal(result.status,'completed');assert.equal(f.accepted.length,2);assert.equal(result.appliedDecisions,2);
});
test('[PM-AC-09-RESPONSES] a hidden ability source never exports its identity or forecasts an activation',async(t)=>{
  const f=await fixture(t,'class-hidden-ability');
  assert.equal(JSON.stringify(f.initial).includes('Hidden secret source'),false);
  assert.equal(f.initial.stack[0].sourceId,bolt,'The public object ID is not a hidden card identity');assert.equal(f.initial.stack[0].abilityType,'ACTIVATED_NONMANA');
  const plan=await f.call('play_turn',{gameId,cursor:f.initial.cursor,actions:[{kind:'choose',select:{cardId:bolt,zone:'battlefield'},guard:{kind:'priority'},expectAbility:{sourceId:bolt,abilityText:levelText}}],finish:'none'});
  let result;
  for(let n=0;n<30;n++){result=await f.call('get_sequence_status',{gameId,sequenceId:plan.sequenceId});if(result.status!=='running')break;await sleep(5);}
  assert.equal(result.reason,'bad_ability_expectation');assert.equal(f.accepted.length,0);
});
test('[PM-AC-09-RESPONSES] HTTP rejects a continuation after Opt before submitting any action',async(t)=>{
  const f=await fixture(t,'opt-terminal');
  const result=await f.client.callTool({name:'play_turn',arguments:{gameId,cursor:f.initial.cursor,actions:[{kind:'play',select:{cardId:bolt}},{kind:'play',select:{cardId:shock}}]}});
  assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'reevaluation_required');assert.equal(f.accepted.length,0);
});
for(const variant of ['library-boundary','random-boundary']) test(`[PM-AC-09-RESPONSES] actual adapter marks a future information choice before a matching predecision: ${variant}`,async(t)=>{
  const f=await fixture(t,variant);
  const library=variant==='library-boundary';
  const plan=await f.call('play_turn',{gameId,cursor:f.initial.cursor,actions:[{kind:'play',select:{cardId:bolt,zone:'hand'}},{kind:'choose',select:library?{cardId:shock}:{label:'Yes'},guard:{kind:library?'target':'question',instruction:library?'Select a card to PUT on the BOTTOM of your library (Scry)':'Choose which flip to keep'}}],finish:'none'});
  let result;
  for(let n=0;n<80;n++){result=await f.call('get_sequence_status',{gameId,sequenceId:plan.sequenceId});if(result.status!=='running')break;await sleep(5);}
  assert.equal(result.reason,'new_information');assert.equal(f.accepted.length,2,'Only the cast and its implicit pass were accepted; the information-dependent answer remains unapplied');
  const state=await f.call('get_game_state',{gameId});
  assert.equal(state.decision.informationBoundary,library?'library_choice':'random_result');
});
test('[PM-AC-09-TURN] HTTP semantic plan can settle its existing stack without inventing another action', async (t) => {
  const f = await fixture(t, 'existing-stack');
  const plan = await f.call('play_turn', { gameId, cursor:f.initial.cursor, actions:[], finish:'none' });
  let result;
  for (let n=0;n<60;n++) { result=await f.call('get_sequence_status',{gameId,sequenceId:plan.sequenceId}); if(result.status!=='running')break; await sleep(5); }
  assert.equal(result.status,'completed'); assert.equal(f.accepted.length,1);
  const state=await f.call('get_game_state',{gameId});
  assert.equal(state.players.find(p=>p.id===rival).life,17);
  assert.equal(state.stack.length,0); assert.equal(state.ownHand[0].id,shock);
});
test('[PM-AC-09-TURN] HTTP rejects an unguarded predetermined discard before any engine action', async (t) => {
  const f=await fixture(t,'own-damage');
  const result=await f.client.callTool({name:'play_turn',arguments:{gameId,cursor:f.initial.cursor,actions:[{kind:'choose',guard:{kind:'target'},select:{cardId:bolt,zone:'hand'}}]}});
  assert.equal(result.isError,true); assert.equal(f.accepted.length,0);
});
test('HTTP MCP discovery exposes explicit advance and brief pacing without removing legacy tools',async(t)=>{
  const f=await fixture(t,'advance');
  const state=await f.call('get_game_state',{gameId});
  assert.equal(state.activePlayerId,own);assert.equal(state.sequenceEvidence.epoch,'synthetic-feed');
  const paced=await f.call('play_sequence',{gameId,cursor:state.cursor,steps:[{kind:'pace',delayMs:1}]});
  for(let i=0;i<30;i++){const r=await f.call('get_sequence_status',{gameId,sequenceId:paced.sequenceId});if(r.status!=='running'){assert.equal(r.status,'completed');assert.ok(r.effectiveDelayMs<=1);return;}await sleep(3);}
  assert.fail('Pacing must terminate');
});
for (const variant of ['own-damage', 'existing-stack', 'opponent-action', 'unexpected-target']) test(`[PM-AC-09-TURN] HTTP semantic casts resolve through the real WebSocket adapter: ${variant}`, async (t) => {
  const f = await fixture(t, variant);
  const actions = [...(variant === 'existing-stack' ? [] : [{ kind:'play', select:{cardId:bolt,zone:'hand'} }]), { kind:'play', select:{cardId:shock,zone:'hand'} }];
  const plan = await f.call('play_turn', { gameId, cursor:f.initial.cursor, actions, finish:'none' });
  let result;
  for (let n=0;n<80;n++) { result=await f.call('get_sequence_status',{gameId,sequenceId:plan.sequenceId}); if(result.status!=='running')break; await sleep(5); }
  const interrupted = ['opponent-action','unexpected-target'].includes(variant);
  assert.equal(result.status, interrupted ? 'interrupted' : 'completed');
  assert.equal(f.accepted.length, interrupted ? 2 : variant === 'existing-stack' ? 3 : 4);
  if (!interrupted) {
    const state=await f.call('get_game_state',{gameId});
    assert.equal(state.players.find(p=>p.id===rival).life,15);
    assert.equal(state.stack.length,0,'finish:none still settles the last declared spell');
    assert.equal(state.turn,3,'No implicit phase/turn advance was requested');
  } else assert.equal(result.reason,variant==='opponent-action'?'opponent_action':'response_available');
});
