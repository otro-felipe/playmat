// One OAuth connection drives four independent synthetic XMage seats. Never export private projections.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function verifyPlayerIdentities({ base, issuer, Cookie, authorizePilot, connect, until, browser, foreignCookie, revokeCanonical }) {
  const options = cookie => ({ Cookie:cookie, Origin:issuer, 'content-type':'application/json' })
  async function createProfile(displayName, flag, mcpEnabled, cookie = Cookie) {
    const response = await fetch(base+'/api/playtesting/players', { method:'POST', headers:options(cookie),
      body:JSON.stringify({displayName,flag,mcpEnabled}) })
    assert.equal(response.status,201)
    return response.json()
  }
  const call = await connect('single-account-coordinator')
  const flags = ['CL','FR','JP',null], basics = ['Forest','Mountain','Plains','Island']
  const pilots = []
  for (const [i,flag] of flags.entries()) {
    const profile = await createProfile('Local pilot '+i,flag,true)
    pilots.push({ ...profile, deck:{ name:'Basics '+i, cards:[{cardName:basics[i],amount:60}],sideboard:[] } })
  }
  const hidden = await createProfile('Disabled pilot',null,false)
  const foreign = await createProfile('Other owner',null,true,await foreignCookie())
  const allowed = async () => (await call('list_players')).players
  const ids = rows => rows.map(row=>row.playerId).sort()
  assert.deepEqual(ids(await allowed()),ids(pilots),'One canonical bearer lists all four enabled account profiles')
  await call('get_game_state',{},'player_required')
  for (const playerId of [hidden.playerId,foreign.playerId,randomUUID()]) {
    await call('get_game_state',{playerId},'player_forbidden')
  }
  const as = (index, name, args = {}, expected) => call(name,{ ...args,playerId:pilots[index].playerId },expected)

  // Abandon a waiting table before taking another reservation for the same profile.
  const first = pilots[0]
  const abandoned = await as(0,'create_game',{name:'Unclaimed fixture',format:'Pioneer',
    guestEngineName:pilots[1].engineName,deck:first.deck})
  const reservation = await as(0,'get_player_reservation')
  assert.equal(reservation.tableId,abandoned.tableId)
  const cancel = {reservationId:reservation.reservationId,tableId:abandoned.tableId}
  await until(async () => {
    const result = await as(0,'cancel_player_reservation',cancel,['reservation_uncertain'])
    if (result) { assert.equal(result.phase,'available'); return true }
    // XMage may acknowledge the removal before the room view reflects it. Verify the
    // persisted cancellation before retrying the identical player, table and reservation.
    const pending = await as(0,'get_player_reservation')
    assert.equal(pending.phase,'cancelling')
    assert.equal(pending.tableId,cancel.tableId)
    assert.equal(pending.reservationId,cancel.reservationId)
    return false
  },'confirmation of the same unclaimed table removal')
  assert.equal((await as(0,'cancel_player_reservation',cancel)).phase,'available')

  const tables = await Promise.all([0,2].map(async i => {
    const { tableId } = await as(i,'create_game',{name:'Local pair '+i,guestEngineName:pilots[i+1].engineName,
      format:'Pioneer',deck:pilots[i].deck})
    await as(i+1,'join_game',{tableId,deck:pilots[i+1].deck})
    return tableId
  }))
  assert.equal(new Set(tables).size,2)
  await Promise.all(tables.map((tableId,pair)=>as(pair*2,'start_match',{tableId})))
  async function chooseStartingPlayer(index, state) {
    if (state.decision?.kind !== 'startingPlayer') return
    const first = state.decision.choices.find(choice=>/^Play first\b/i.test(choice.label))
    assert.ok(first, 'An observed starting player chooses from its own legal prompt')
    await as(index,'submit_decision',{gameId:state.gameId,cursor:state.cursor,decisionId:state.decision.id,
      choiceId:first.id,idempotencyKey:state.decision.id},['not_actionable','stale_decision'])
  }
  const states = await until(async()=>{
    const observed = await Promise.all(pilots.map((_,i)=>as(i,'get_game_state')))
    await Promise.all(observed.map((state,i)=>chooseStartingPlayer(i,state)))
    return observed.every(s=>s.status==='active' && s.gameId && s.ownHand?.length && s.decision?.kind!=='startingPlayer') && observed
  },'four distinct seat projections on two simultaneously active tables')
  for (const [i,state] of states.entries()) {
    assert.equal(state.tableId,tables[Math.floor(i/2)])
    assert.equal(state.gameId,states[i ^ 1].gameId)
    assert.notEqual(state.gameId,states[i ^ 2].gameId)
    assert.ok(state.ownHand.length>0 && state.ownHand.every(card=>card.name===basics[i]))
    assert.ok(!JSON.stringify(state).includes('"name":"'+basics[i ^ 1]+'"'),'No opposing opening cards in this projection')
    assert.equal(state.players.find(p=>p.yourSeat).flagName,(flags[i]??'world').toLowerCase()+'.png')
    assert.equal(state.players.find(p=>!p.yourSeat).flagName,(flags[i ^ 1]??'world').toLowerCase()+'.png')
    await as(i,'get_game_state',{gameId:states[i ^ 2].gameId},'forbidden_game')
  }

  // Identical gameId and commandId on opposite seats must resolve within each selected ledger.
  const commandId='keep-the-observed-hand'
  const receipts = new Map()
  await Promise.all([0,2,1,3].map(async i => {
    let state = await as(i,'get_game_state')
    const deadline = Date.now()+90_000
    while (Date.now()<deadline) {
      const {gameId,cursor,decision}=state
      if (decision?.kind==='mulligan') {
        const keep = decision.choices.find(c=>/^Keep\b/i.test(c.label))
        assert.ok(keep,'The mulligan prompt offers Keep')
        const reply=await as(i,'play_line',{gameId,cursor,commandId,waitMs:25000,view:'compact',
          actions:[{kind:'choose',decisionId:decision.id,choiceId:keep.id}]})
        if (reply.status==='rejected' && reply.code==='stale_decision') {
          // The peer may have advanced the shared cursor without answering this seat's question.
          assert.equal(reply.appliedDecisions,0)
          state=reply.state
          continue
        }
        assert.equal(reply.appliedDecisions,1)
        assert.ok(reply.sequenceId)
        receipts.set(i,reply.sequenceId)
        return
      }
      await chooseStartingPlayer(i,state)
      const event=await as(i,'wait_for_decision',{gameId,afterCursor:cursor,timeoutMs:5000,view:'compact'})
      state=event.state
    }
    assert.fail('No Keep for fixture seat '+i+' (status '+state.status+', decision '+state.decision?.kind+', turn '+state.turn+')')
  }))
  assert.equal(new Set(receipts.values()).size,4)
  for (const [i,sequenceId] of receipts) {
    const recovered=await as(i,'wait_for_decision',{gameId:states[i].gameId,commandId,timeoutMs:100})
    assert.equal(recovered.sequenceId,sequenceId)
    assert.equal(recovered.appliedDecisions,1)
  }
  await call('get_game_state',{},'player_required')

  // A separate, profile-bound grant is a negative authorization control only.
  const fixed = await connect('single-profile-control',await authorizePilot(pilots[1].playerId))
  assert.deepEqual(ids((await fixed('list_players')).players),[pilots[1].playerId])
  await fixed('get_game_state',{playerId:first.playerId},'player_forbidden')
  // Disabling one profile during its active game takes effect on the same client immediately.
  const disabled = await fetch(base+'/api/playtesting/players/'+first.playerId,{method:'PATCH',headers:options(Cookie),
    body:JSON.stringify({mcpEnabled:false})})
  assert.equal(disabled.status,200)
  assert.deepEqual(ids(await allowed()),ids(pilots.slice(1)))
  await as(0,'get_game_state',{gameId:states[0].gameId},'player_forbidden')
  await as(0,'wait_for_decision',{gameId:states[0].gameId,commandId,timeoutMs:100},'player_forbidden')
  assert.equal((await as(1,'get_game_state')).gameId,states[0].gameId)
  await Promise.all([1,2].map(i=>as(i,'concede',{gameId:states[i].gameId,entireMatch:true})))
  await until(async()=>{
    const views=await (await fetch(base+'/api/playtesting/players',{headers:{Cookie}})).json()
    return pilots.every(pilot=>views.players.find(p=>p.playerId===pilot.playerId)?.activeTableId===null)
  },'archive closure to release all four reservations, including the disabled profile')

  assert.equal((await fixed('get_player_reservation')).phase,'available','A fixed grant may omit its profile selector')
  // The browser remains the human table owner when the same connection coordinates MCP profiles.
  await browser.open()
  const room = await browser.api.serverGetMainRoomId()
  const human = await call('create_human_match',{mode:'friend',humanMcpAllowed:false,format:'Pioneer',
    winsNeeded:1,name:'Owner-only table',deck:first.deck})
  assert.equal(await browser.api.tableIsOwner(room,human.tableId),true)
  await call('get_game_state',{humanTableId:human.tableId},'human_seat_forbidden')
  await as(1,'get_game_state',{humanTableId:human.tableId},'player_forbidden')
  await browser.api.tableRemove(room,human.tableId)
  await revokeCanonical()
  await assert.rejects(()=>call('list_players'),/401|unauthoriz/i)
  console.log('Verified a single canonical OAuth bearer and MCP session for four profiles, interleaved games and receipts, owner-only human control and live revocation.')
}
