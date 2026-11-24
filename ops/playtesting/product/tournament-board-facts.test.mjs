import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { publicSpectatorBoard } from './public-spectator-board.mjs'
import { createTournamentBroadcast } from './tournament-broadcast.mjs'

test('the spectator separates a stack target, actual attachment, declared attackers and recorded damage', () => {
  const [a,b,actor,land,gear,ability,spell,exiled,hidden] = Array.from({length:9}, () => randomUUID())
  const players = [{playerId:a,name:'North'}, {playerId:b,name:'South'}]
  const permanent = {id:actor,name:'Attacker',power:'25',toughness:'25'}
  const state = { gameId:randomUUID(), status:'playing', players,
    lines:[{lineId:'test',explanation:'Deal 25 damage; exile the land',audience:'public'}],
    view:{ players:[{...players[0],battlefield:{
      [actor]:permanent, [land]:{id:land,name:'Animated land',power:'2',summoningSickness:true},
      [gear]:{id:gear,name:'Equipment',attachedTo:actor},
    }}, {...players[1],life:7,battlefield:{[hidden]:{id:hidden,faceDown:true,name:'private fixture'}}}],
    stack:{[ability]:{id:ability,isAbility:true,sourceCard:{id:actor},targets:[land,exiled,hidden],chosenTargetIds:[exiled,hidden]},
      [spell]:{id:spell,name:'Interaction',targets:[land,gear],chosenTargetIds:[gear]}},
    combat:[{attackers:{[actor]:permanent},defenderId:b}],
    exiles:[{[exiled]:{id:exiled,name:'Exiled permanent'}}],
    events:[{seq:1,kind:'DAMAGE',combat:true,amount:22,sourceId:actor,targetId:b,targetName:'untrusted'},
      {seq:1,kind:'DAMAGE',combat:true,amount:22,sourceId:actor,targetId:b},
      {seq:2,kind:'ZONE',fromZone:'BATTLEFIELD',toZone:'EXILED',targetId:exiled,sourceId:actor},
      {seq:3,kind:'ZONE',fromZone:'HAND',toZone:'EXILED',targetId:hidden,targetName:'private fixture'}] }}
  const {facts} = publicSpectatorBoard(state)
  const of = kind => facts.filter(row => row.kind === kind)
  assert.deepEqual(of('target'), [{kind:'target',source:'Attacker',target:'Exiled permanent',ability:true}, {kind:'target',source:'Interaction',target:'Equipment'}])
  assert.deepEqual(of('attached'), [{kind:'attached',source:'Equipment',target:'Attacker'}])
  assert.deepEqual(of('attacker'), [{kind:'attacker',source:'Attacker',target:'South',power:'25'}])
  assert.deepEqual(of('damage'), [{kind:'damage',source:'Attacker',target:'South',amount:22}])
  assert.deepEqual(of('exiled'), [{kind:'exiled',target:'Exiled permanent'}])
  assert.ok(!JSON.stringify(facts).includes('private fixture'))
  delete state.view.events
  assert.ok(!publicSpectatorBoard(state).facts.some(f => ['damage','exiled'].includes(f.kind)))
  delete state.view.stack[ability].chosenTargetIds
  assert.ok(!publicSpectatorBoard(state).facts.some(f => f.kind === 'target' && f.source === 'Attacker'))
})

test('a saved tournament frame returns the pilot comment independently of the recorded outcome', async t => {
  const [cup,pair,table,game,a,b,source] = Array.from({length:7}, () => randomUUID())
  const players = [{playerId:a,name:'North'}, {playerId:b,name:'South'}]
  const match = {id:pair,table_id:table,completed:true,name_a:'North',name_b:'South',display_a:'North',display_b:'South'}
  const pool = {query: async sql => ({rows:sql.includes('JOIN tournament_entries') ? [match] : [{id:game,object_key:'fixture',checksum:'fixture'}]})}
  const archive = {async *streamTournamentRecords() {
    yield {kind:'line',audience:'public',actorPlayerId:a,commandId:'plan',explanation:'I expect 25 damage.',at:1}
    yield {view:{players:[{...players[0],battlefield:{[source]:{id:source,name:'Attacker',power:'25'}}},players[1]],
      events:[{seq:1,kind:'DAMAGE',sourceId:source,targetId:b,amount:22}]}}
  }}
  const broadcast = createTournamentBroadcast(pool,archive)
  t.after(() => broadcast.close())
  const frame = await broadcast.replay(cup,pair,null,new URLSearchParams({gameId:game,frame:'0'}))
  assert.deepEqual(frame.lines.map(line => line.explanation), ['I expect 25 damage.'])
  assert.deepEqual(frame.facts, [{kind:'damage',source:'Attacker',target:'South',amount:22}])
})
