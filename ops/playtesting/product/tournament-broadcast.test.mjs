import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createTournamentBroadcast } from './tournament-broadcast.mjs'

test('replay shows only published decisions up to the selected frame, attributed to the player', async t => {
  const [event, pair, table, game, a, b] = Array.from({ length: 6 }, () => randomUUID())
  const view = { players: [{ name: 'a', playerId: a }, { name: 'b', playerId: b }] }
  const marker = { kind: 'line', actorPlayerId: a, commandId: 'first', at: 11, turn: 2,
    audience: 'public', explanation: 'Ataco para presionar sus vidas.' }
  const records = [{ view }, { kind: 'line', actorPlayerId: b, commandId: 'legacy', reasoning: 'private' },
    marker, marker, { view }, { ...marker, actorPlayerId: b, commandId: 'second', at: 14, explanation: 'Bloqueo.' }, { view },
    { ...marker, commandId: 'terminal', at: 15, explanation: 'El daño en mesa es letal.' }]
  const row = { id: pair, table_id: table, completed: true, name_a: 'a', name_b: 'b',
    display_a: 'Brasa', display_b: 'Cirro', owner_a: 'Felipe', owner_b: 'Felipe', player_a: a, player_b: b }
  const pool = { async query(sql) {
    return { rows: sql.includes('JOIN tournament_entries') ? [row] : [{ id: game, checksum: 'v1', object_key:'fixture' }] }
  } }
  const broadcast = createTournamentBroadcast(pool, { streamTournamentRecords() { return records } })
  t.after(() => broadcast.close())
  async function notes(frame) {
    const result = await broadcast.replay(event, pair, null, new URLSearchParams({ gameId: game, frame }))
    return result.lines.map(note => [note.playerId, note.explanation])
  }
  assert.deepEqual(await notes(0), [])
  assert.deepEqual(await notes(1), [[a, marker.explanation]])
  assert.deepEqual(await notes(2), [[a, marker.explanation], [b, 'Bloqueo.'], [a, 'El daño en mesa es letal.']])
})

test('official AFK, game result and last playable board remain independent; a missing terminal event stays unknown', async t => {
  const [event, pair, table, game, a, b] = Array.from({ length: 6 }, () => randomUUID())
  const players = [{name:'a',playerId:a},{name:'b',playerId:b}]
  const row = { id:pair, table_id:table, completed:true, name_a:'a',name_b:'b',display_a:'Alpha',display_b:'Beta',
    wins_a:1,wins_b:0,draws:0,winner_side:'a',result_reason:'afk' }
  const gameRow = { id:game,object_key:'fixture',game_number:1,checksum:'one',status:'completed',archive_state:'ready',winner:'a' }
  let records = [{view:{players,turn:7,step:'PRECOMBAT_MAIN'},t:100},
    {kind:'spectatorTalk',message:'unverified private message'}, {kind:'spectatorEnd',untrusted:'private'}]
  const pool = {async query(sql) { return {rows:[sql.includes('JOIN tournament_entries')?row:gameRow]} }}
  const broadcast = createTournamentBroadcast(pool,{streamTournamentRecords:()=>records})
  t.after(()=>broadcast.close())
  const manifest = () => broadcast.replay(event,pair,null,new URLSearchParams())
  let index = await manifest()
  assert.deepEqual(index.officialResult,{a:'Alpha',b:'Beta',winsA:1,winsB:0,draws:0,winner:'a',reason:'afk'})
  let capture=index.games[0].capture
  assert.equal(capture.exportState,'ready')
  assert.equal(capture.terminalEvent,false, 'legacy recorder close is also written on abandonment')
  assert.deepEqual(capture.lastPublicEvent,{kind:'recording_closed'})
  assert.equal(capture.cause,null)
  assert.equal(capture.outcome,'a')
  assert.deepEqual(capture.lastBoard,{frame:0,status:'playing',turn:7,step:'PRECOMBAT_MAIN'})
  assert.doesNotMatch(JSON.stringify(index),/private/)
  Object.assign(row,{wins_b:1,draws:1,winner_side:null,result_reason:'played'})
  Object.assign(gameRow,{checksum:'two',game_number:3,winner:null,result:'Game is a draw'})
  records=[{view:{players,turn:15,step:'CLEANUP'},t:140}]
  index=await manifest()
  assert.deepEqual(index.officialResult,{a:'Alpha',b:'Beta',winsA:1,winsB:1,draws:1,winner:null,reason:'played'})
  assert.equal(index.games[0].gameNumber,3)
  assert.deepEqual(index.games[0].capture.lastPublicEvent,{kind:'board',elapsedMs:140})
  assert.equal(index.games[0].capture.lastBoard.step,'CLEANUP')
  assert.equal(index.games[0].capture.cause,null)
  assert.equal(index.games[0].capture.terminalEvent,false)
  for (const cause of ['concession','disconnect','player_clock','round_clock','inactivity','untrusted']) {
    gameRow.checksum=cause
    records=[{view:{players,turn:15,step:'CLEANUP'},t:140},{kind:'spectatorEnd',terminal:true,cause}]
    capture=(await manifest()).games[0].capture
    assert.equal(capture.terminalEvent,true)
    assert.equal(capture.lastBoard.status,'playing')
    assert.equal(capture.cause,cause==='untrusted'?null:cause)
  }
  gameRow.checksum = 'terminal-board'
  records = [{view:{players,turn:4,step:'UPKEEP'},terminalBoard:true,t:141},
    {kind:'spectatorEnd',terminal:true,cause:'concession',t:142}]
  capture=(await manifest()).games[0].capture
  assert.deepEqual(capture.lastPublicEvent,{kind:'game_end',elapsedMs:142})
  assert.equal(capture.lastBoard.status,'finished')
  const finalFrame=await broadcast.replay(event,pair,null,new URLSearchParams({gameId:game,frame:0}))
  assert.equal(finalFrame.status,'finished')
  Object.assign(gameRow,{truncated:true,archive_state:'ready'})
  assert.equal((await manifest()).games[0].capture.exportState,'partial')
  Object.assign(gameRow,{object_key:null,archive_state:'pending',truncated:false})
  const missing=(await manifest()).games[0]
  assert.equal(missing.frameCount,0)
  assert.equal(missing.capture.exportState,'pending')
  assert.equal(missing.capture.terminalEvent,false)
  assert.equal(missing.capture.lastBoard,null)
  await assert.rejects(broadcast.replay(event,pair,null,new URLSearchParams({gameId:game})),{status:404})
})

test('the pairing clock and score use the native seats during play and the recorded result after completion', async t => {
  const [event, pair, table, game, a, b] = Array.from({ length: 6 }, () => randomUUID())
  const deadline = 1795500000000
  const row = { id: pair, table_id: table, deadline_at: String(deadline), completed: false, wins_a: 0, wins_b: 0,
    name_a: 'seat-a', name_b: 'seat-b', display_a: 'Brasa', display_b: 'Cirro' }
  const players = [{ name: 'seat-b', playerId: b }, { name: 'seat-a', playerId: a }]
  let snapshot = null
  const broadcast = createTournamentBroadcast({ async query() { return { rows: [row] } } }, {},
    async () => snapshot && ({ snapshot }))
  t.after(() => broadcast.close())
  const score = (a, b) => [{ name: 'Brasa', wins: a }, { name: 'Cirro', wins: b }]

  const waiting = await broadcast.live(event, pair, null, false)
  assert.deepEqual(waiting.matchScore, score(0, 0))
  assert.equal(waiting.deadlineAt, deadline)
  assert.equal(waiting.status, 'waiting')

  snapshot = { tableId: table, gameId: game, status: 'between_games', players,
    view: { players: players.map(p => ({ ...p, wins: 0 })) },
    matchWins: { 'seat-b': 0, 'seat-a': 1, 'someone-else': 42 } }
  const between = await broadcast.live(event, pair, null, false)
  assert.deepEqual(between.matchScore, score(1, 0))
  assert.equal(between.deadlineAt, deadline)
  assert.equal(between.matchWins, undefined)
  assert.equal(between.status, 'between_games')

  delete snapshot.matchWins
  snapshot.status = 'playing'
  snapshot.view.players = players.map(p => ({ ...p, wins: 1 }))
  assert.deepEqual((await broadcast.live(event, pair, null, false)).matchScore, score(1, 1))

  Object.assign(row, { completed: true, wins_a: 2, wins_b: 1 })
  snapshot.status = 'playing'
  const finished = await broadcast.live(event, pair, null, false)
  assert.deepEqual(finished.matchScore, score(2, 1))
  assert.equal(finished.deadlineAt, undefined)
  assert.equal(finished.status, 'finished')
})
