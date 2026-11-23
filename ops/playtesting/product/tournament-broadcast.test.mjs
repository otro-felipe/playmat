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
    return { rows: sql.includes('JOIN tournament_entries') ? [row] : [{ id: game, checksum: 'v1' }] }
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
