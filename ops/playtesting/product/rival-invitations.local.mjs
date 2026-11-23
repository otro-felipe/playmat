// Invoked exclusively by the isolated real-engine fixture through its two canonical OAuth clients.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function verifyRivalInvitations({ base, issuer, Cookie, browser, call, pilots, peer, foreign }) {
  await browser.open()
  const roomId = await browser.api.serverGetMainRoomId()
  const deck = pilots[0].deck

  async function host(allowExternal) {
    const password = randomUUID()
    const { tableId } = await browser.api.roomCreateTable(roomId, {
      name:'MCP invitation fixture', gameType:'Two Player Duel', deckType:'Constructed - Pioneer',
      playerTypes:['HUMAN','HUMAN'], winsNeeded:1, rated:false, spectatorsAllowed:false, password,
    })
    assert.ok(await browser.api.roomJoinTable(roomId, tableId, browser.engineName, 'HUMAN', 1, deck, password))
    const res = await fetch(base+'/api/playtesting/invites', {
      method:'POST', headers:{ Cookie, Origin:issuer, 'Content-Type':'application/json' },
      body:JSON.stringify({ tableId, roomId, mode:'mcp', format:'Pioneer', password,
        ...(allowExternal ? { allowExternalMcp:true } : {}) }),
    })
    assert.equal(res.status,201)
    return tableId
  }

  const ownTable = await host(false)
  for (const args of [{}, {playerId:pilots[0].playerId}, {playerId:pilots[1].playerId}]) {
    const { invites } = await call('list_joinable_games',{tableId:ownTable,...args})
    assert.equal(invites.length,1)
    assert.equal(invites[0].requiresPlayerAssignment,true)
  }
  assert.equal((await peer('list_joinable_games',{tableId:ownTable})).invites.length,0)
  await call('join_game',{tableId:ownTable,playerId:pilots[1].playerId,deck})
  assert.equal((await call('list_joinable_games',{tableId:ownTable,playerId:pilots[0].playerId})).invites.length,0)
  assert.ok(await browser.api.tableRemove(roomId,ownTable))

  const sharedTable = await host(true)
  assert.equal((await peer('list_joinable_games',{tableId:sharedTable})).invites.length,0)
  assert.ok(!(await peer('list_joinable_games')).invites.some(row => row.tableId===sharedTable))
  await peer('join_game',{tableId:sharedTable,playerId:foreign.playerId,deck},'not_found')
  const linkResponse = await fetch(base+'/api/playtesting/invites/'+sharedTable+'/share-link',{headers:{Cookie}})
  assert.equal(linkResponse.status,200)
  const {path} = await linkResponse.json()
  const inviteLink = new URL(path,issuer).href
  assert.equal(new URL(inviteLink).pathname,'/join/mcp/'+sharedTable)
  const landing = await fetch(base+new URL(inviteLink).pathname,{redirect:'manual'})
  assert.equal(landing.status,200)
  const { invites } = await peer('list_joinable_games',{inviteLink})
  assert.ok(invites.some(row=>row.tableId===sharedTable && row.requiresPlayerAssignment))
  await peer('join_game',{inviteLink,playerId:foreign.playerId,deck})
  const table = await browser.api.roomGetTableById(roomId,sharedTable)
  assert.ok(table.seats.some(s=>s.playerName===foreign.engineName),'The external player took the real XMage seat')
  assert.ok(await browser.api.tableRemove(roomId,sharedTable))
  console.log('Verified owner default, external invitation handoff and actual seats through two synthetic OAuth accounts.')
}
