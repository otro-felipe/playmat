import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { publicSpectatorBoard } from './public-spectator-board.mjs'

const tableId=randomUUID(), gameId=randomUUID(), playerId=randomUUID()
const privateText='PRIVATE FIXTURE MARKER'
const visible={id:randomUUID(),name:'Grizzly Bears',expansionSetCode:'LEA',cardNumber:'197',cardTypes:['CREATURE'],power:'2',toughness:'2',
  enteringSpellId:privateText,zoneChangeCounter:privateText,rules:[privateText],original:{name:privateText},settings:{secret:privateText}}
const hidden={id:randomUUID(),cardId:randomUUID(),faceDown:true,name:privateText,imageFileName:privateText,expansionSetCode:'LEA',cardNumber:'197',
  original:{name:privateText},cardTypes:['LEGENDARY'],tapped:true,power:'9',targets:[privateText],extra:{privateText}}
function frame(status='playing', id=gameId) {
  return {role:'spectator',tableId,gameId:id,status,revision:17,players:[{playerId,name:'MCP_A',control:'mcp',displayName:'Pilot A',flag:'CL',key:privateText}],
    hands:{[playerId]:{hidden}},review:{seatViews:{privateText}},chat:[{message:privateText}],lines:[{reasoning:privateText}],token:privateText,
    view:{turn:2,step:'DECLARE_ATTACKERS',phase:'COMBAT',activePlayerId:playerId,activePlayerName:'MCP_A',priorityPlayerName:'MCP_A',
      myHand:{hidden},lookedAt:[privateText],decision:privateText,sequenceEvidence:{privateText,ownImpulseExile:{cardId:privateText}},
      players:[{playerId,name:'MCP_A',life:17,handCount:5,libraryCount:49,hasPriority:true,wins:1,winsNeeded:2,topCard:hidden,sideboard:{hidden},
        battlefield:{[visible.id]:visible,[privateText]:hidden},graveyard:{[visible.id]:visible},exile:{[hidden.id]:hidden},commandList:[visible],userData:{privateText}}],
      stack:{[hidden.id]:{...hidden,faceDown:false}},combat:[{attackers:{[hidden.id]:{...hidden,faceDown:false}},blockers:{},defenderId:playerId,comments:privateText}],
      exiles:[{[hidden.id]:hidden}],revealed:[{name:privateText,cards:{[visible.id]:visible}}],companion:[{cards:{[visible.id]:visible}}]}}
}

test('spectators keep the browser frame and public board across waiting, both games, and the archived finish',()=>{
  const game2=randomUUID()
  const waiting=publicSpectatorBoard({...frame('waiting',null),view:null})
  assert.equal(waiting.visibility,'public-board')
  assert.equal(waiting.view,null)
  assert.equal(waiting.gameId,null)
  for (const [status,id] of [['playing',gameId],['between_games',gameId],['playing',game2],['finished',game2]]) {
    const result=publicSpectatorBoard(frame(status,id))
    assert.deepEqual([result.role,result.tableId,result.status,result.gameId,result.revision],['spectator',tableId,status,id,17])
    assert.deepEqual([result.hands,result.lines,result.chat],[{},[],[]])
    assert.deepEqual(result.players,[{playerId,name:'MCP_A',control:'mcp',displayName:'Pilot A',flag:'CL'}])
    assert.equal(result.view.step,'DECLARE_ATTACKERS')
    const p=result.view.players[0]
    assert.deepEqual([p.life,p.handCount,p.libraryCount,p.wins,p.winsNeeded],[17,5,49,1,2])
    for (const card of [p.battlefield[visible.id],p.graveyard[visible.id],p.commandList[0],result.view.revealed[0].cards[visible.id],
      result.view.companion[0].cards[visible.id]]) assert.equal(card.name,visible.name)
    assert.ok(!JSON.stringify(result).includes(privateText))
  }
})

test('face-down and concealed representations share only a public sleeve in every public zone and combat mirror',()=>{
  const f=frame(),view=publicSpectatorBoard(f).view
  const masked=Object.values(view.players[0].battlefield).find(c=>c.faceDown)
  assert.deepEqual(masked,{id:masked.id,faceDown:true,tapped:true})
  for (const map of [view.stack,view.combat[0].attackers,view.players[0].exile,view.exiles[0]]) {
    assert.deepEqual(Object.keys(map),[masked.id])
    assert.equal(Object.values(map)[0].faceDown,true)
  }
  for(const marker of [hidden.id,hidden.cardId,privateText]) assert.ok(!JSON.stringify(view).includes(marker))
  for(const flag of ['faceDown','hideInfo','morphed','manifested','cloaked','disguised']) {
    const id=randomUUID(); f.view.stack={[id]:{...visible,id,[flag]:flag==='faceDown' ? 'true' : true}}
    const sleeve=Object.values(publicSpectatorBoard(f).view.stack)[0]
    assert.equal(sleeve.faceDown,true)
    assert.deepEqual(Object.keys(sleeve).sort(),['faceDown','id'])
  }
})

test('untrusted nested presentation fields never become public values, map keys, or stack ability captions',()=>{
  const f=frame()
  f.view.stack={
    [privateText]:{id:privateText,name:'Ability',isAbility:true,sourceCard:hidden,displayName:privateText},
    [randomUUID()]:{id:randomUUID(),name:privateText,isAbility:true,sourceCard:visible,rules:[privateText]},
  }
  const p=f.view.players[0]
  p.handCount={name:privateText}; p.life=[privateText]; p.topCard=visible
  f.players[0].flag={privateText}; f.view.step=privateText; f.view.priorityPlayerName=privateText
  const projection=publicSpectatorBoard(f)
  assert.ok(!JSON.stringify(projection).includes(privateText))
  assert.equal(Object.values(projection.view.stack).some(c=>c.faceDown),true)
  assert.equal(Object.values(projection.view.stack).some(c=>c.name==='Ability'),true)
  assert.equal(Object.hasOwn(projection.view.players[0],'topCard'),false)
})

test('a concealed nested source also protects its unmarked public mirror and opaque archive keys',()=>{
  const f=frame(), id=randomUUID(), sourceId='archive-object-without-uuid'
  f.view.stack={[id]:{id,sourceCard:{id:sourceId,hideInfo:true,name:privateText}}}
  f.view.combat=[{attackers:{[sourceId]:{id:sourceId,name:privateText}},blockers:{}}]
  f.view.revealed=[{cards:{[visible.id]:{...visible,zone:'HAND'}}}]
  const result=publicSpectatorBoard(f)
  assert.equal(Object.values(result.view.combat[0].attackers)[0].faceDown,true)
  assert.deepEqual(result.view.revealed[0].cards,{})
  assert.ok(!JSON.stringify(result).includes(sourceId))
  assert.ok(!JSON.stringify(result).includes(privateText))
})

test('numeric counters survive while input-only arbitrary counter labels and embedded text are withheld',()=>{
  const f=frame(),p=f.view.players[0]
  p.counters=[{name:'poison',count:2,caption:privateText},{name:privateText,count:1}]
  p.battlefield[visible.id]={...visible,counters:[{name:'+1/+1',count:3}]}
  const result=publicSpectatorBoard(f)
  assert.deepEqual(result.view.players[0].counters,[{name:'poison',count:2},{name:'Counter',count:1}])
  assert.deepEqual(result.view.players[0].battlefield[visible.id].counters,[{name:'+1/+1',count:3}])
  assert.ok(!JSON.stringify(result).includes(privateText))
})

test('nested identities inside a concealed permanent cannot reappear in mirrors under a second object id',()=>{
  const f=frame(), originalId=randomUUID()
  f.view.players[0].battlefield={[hidden.id]:{...hidden,original:{id:originalId,name:privateText}}}
  f.view.combat=[{attackers:{[originalId]:{id:originalId,name:privateText}},blockers:{}}]
  const projected=publicSpectatorBoard(f)
  assert.equal(Object.values(projected.view.combat[0].attackers)[0].faceDown,true)
  assert.ok(!JSON.stringify(projected).includes(originalId))
  assert.ok(!JSON.stringify(projected).includes(privateText))
})

test('[PM-LINE-PUBLIC] public board publishes only marked lines with authenticated roster and no table chat',()=>{
  const f=frame(), explanation='A'.repeat(4000)
  const first={lineId:gameId+':'+playerId+':internal-command-name',playerId,playerName:'forged',explanation,audience:'public',at:10,turn:2,reasoning:privateText}
  f.lines=[{...first,audience:undefined},first,{...first},{...first,lineId:'bad',playerId:randomUUID()},
    {...first,lineId:'too-long',explanation:explanation+'!'},{...first,lineId:gameId+':'+playerId+':b',at:11,explanation:'Pass.'}]
  const r=publicSpectatorBoard(f)
  assert.deepEqual(r.lines.map(({explanation,at,playerName})=>[explanation,at,playerName]),[[explanation,10,'MCP_A'],['Pass.',11,'MCP_A']])
  assert.deepEqual(r.chat,[])
  assert.ok(!JSON.stringify(r).includes(privateText))
  assert.ok(!JSON.stringify(r).includes('internal-command-name'))
  assert.deepEqual(publicSpectatorBoard(f).lines,r.lines)
})

test('[PM-LINE-PUBLIC] restart rebuilds the same public feed alongside separately authorized historical talk', async()=>{
  const {spectatorStorage}=await import('./spectators.mjs')
  const marker={kind:'line',actorPlayerId:playerId,commandId:'same',audience:'public',explanation:'Attack.',at:50,turn:4}
  const pool={query:async sql=>({rows:sql.includes('FROM matches')?[{id:gameId,object_key:'test',started_at:0}]:[{playerId,name:'MCP_A'}]})}
  const storage=spectatorStorage(pool,{readReviewArchive:async()=>[
    {view:frame().view},{kind:'line',commandId:'old',actorPlayerId:playerId,reasoning:'Legacy only',at:42},marker,{...marker},
    {kind:'spectatorTalk',chat:{playerName:'MCP_A',message:'Talk only',messageId:1,at:43}}]})
  const archived=await storage.finished(tableId,{live_table_id:tableId})
  const publicFrame=publicSpectatorBoard(archived)
  assert.deepEqual(publicFrame.lines.map(x=>x.explanation),['Attack.'])
  assert.deepEqual(publicFrame.chat,[])
  const legacy=await storage.finished(tableId,null)
  assert.deepEqual(legacy.lines.map(x=>x.explanation??x.reasoning),['Legacy only','Attack.'])
  assert.deepEqual(legacy.chat.map(x=>x.message),['Talk only'])
})
