// Executed only within human-match.local's isolated synthetic OAuth/PG/XMage fixture.
import assert from 'node:assert/strict'

export async function verifyPlayerIdentities({ base, issuer, Cookie, authorizePilot, connect, until }) {
  const flags = ['CL','FR','JP',null]
  const lands = ['Forest','Mountain','Plains','Island']
  const pilots = []
  for (const [i,flag] of flags.entries()) {
    const created = await fetch(base + '/api/playtesting/players', { method:'POST',
      headers:{ Cookie, Origin:issuer, 'content-type':'application/json' },
      body:JSON.stringify({ displayName:'Fixture player '+i, mcpEnabled:true, flag }) })
    assert.equal(created.status,201)
    const profile = await created.json()
    const token = await authorizePilot(profile.playerId)
    const call = await connect('profile-fixture-' + i, token)
    const { players } = await call('list_players')
    assert.deepEqual(players.map(p=>[p.playerId,p.flag]),[[profile.playerId,flag]])
    pilots.push({ ...profile, call, deck:{ name:'Basics '+i, cards:[{cardName:lands[i],amount:60}], sideboard:[] } })
  }
  const tables = await Promise.all([0,2].map(async i => {
    const host=pilots[i], guest=pilots[i+1]
    const { tableId } = await host.call('create_game',{ playerId:host.playerId, name:'Isolated pair '+i,
      guestEngineName:guest.engineName, format:'Pioneer', deck:host.deck })
    await guest.call('join_game',{ playerId:guest.playerId, tableId, deck:guest.deck })
    return tableId
  }))
  assert.equal(new Set(tables).size,2)
  await Promise.all(tables.map((tableId,pair)=>pilots[pair*2].call('start_match',{tableId})))
  const states = await until(async()=>{
    const observed = await Promise.all(pilots.map(p=>p.call('get_game_state',{playerId:p.playerId})))
    for (const [i,state] of observed.entries()) {
      if (!state.gameId || !state.decision || state.ownHand?.length) continue
      const pick = state.decision.choices.find(c=>/^Play first\b/i.test(c.label)) ?? state.decision.choices[0]
      if (pick) await pilots[i].call('submit_decision',{gameId:state.gameId,decisionId:state.decision.id,
        choiceId:pick.id,idempotencyKey:state.decision.id},['not_actionable','stale_decision'])
    }
    return observed.every(s=>s.status==='active' && s.gameId && s.ownHand?.length) && observed
  },'four individual opening hands across two simultaneous tables')
  for (const [i,state] of states.entries()) {
    const pair=Math.floor(i/2)
    assert.equal(state.tableId,tables[pair])
    assert.equal(state.gameId,states[i ^ 1].gameId)
    assert.notEqual(state.gameId,states[i ^ 2].gameId)
    assert.ok(state.ownHand.every(card=>card.name===lands[i]))
    assert.equal(state.players.find(player=>player.yourSeat).flagName,(flags[i]??'world').toLowerCase()+'.png')
    assert.equal(state.players.find(player=>!player.yourSeat).flagName,(flags[i ^ 1]??'world').toLowerCase()+'.png')
    await pilots[i].call('get_game_state',{playerId:pilots[i ^ 1].playerId},'player_forbidden')
    await pilots[i].call('get_game_state',{gameId:states[i ^ 2].gameId},'forbidden_game')
  }
  await Promise.all([0,2].map(i=>pilots[i].call('concede',{gameId:states[i].gameId,entireMatch:true})))
  await until(async()=> {
    const views=await Promise.all(pilots.map(p=>p.call('list_players')))
    return views.every(view=>view.players[0]?.activeTableId===null)
  }, 'archive completion to release all four durable reservations')
  console.log('Verified four OAuth players, real XMage table flags and private hands, two simultaneous games and four released PostgreSQL reservations.')
}
