import { isUuid, normalize, ProductError } from './decks.mjs'
import { publicSpectatorBoard } from './public-spectator-board.mjs'
import { privateSpectatorBoard } from './private-spectator-board.mjs'
import { lineText } from './line-explanations.mjs'
import { readSpectatorEngine } from './spectators.mjs'

const missing = () => new ProductError(404, 'This tournament broadcast is unavailable')

export function createTournamentBroadcast(pool, archive, engine = readSpectatorEngine) {
  async function pairing(id, pairId) {
    if (![id, pairId].every(isUuid)) throw missing()
    const {
      rows: [row],
    } = await pool.query(
      `SELECT p.id,p.table_id,p.match_id,p.completed,
      a.engine_name AS name_a,a.name AS display_a,a.owner_name AS owner_a,a.player_id AS player_a,
      b.engine_name AS name_b,b.name AS display_b,b.owner_name AS owner_b,b.player_id AS player_b
      FROM tournament_pairings p JOIN tournament_entries a ON a.id=p.entry_a
      JOIN tournament_entries b ON b.id=p.entry_b WHERE p.tournament_id=$1 AND p.id=$2`,
      [id, pairId],
    )
    if (!row?.table_id) throw missing()
    return row
  }

  function roster(players, match) {
    return (players ?? []).map((p) => {
      const side =
        normalize(p.name) === normalize(match.name_a)
          ? 'a'
          : normalize(p.name) === normalize(match.name_b)
            ? 'b'
            : null
      if (!side) throw missing()
      const owner = match['owner_' + side],
        name = match['display_' + side]
      return {
        name: p.name,
        playerId: p.playerId,
        displayName: match['player_' + side] ? name + ' · ' + owner : name,
      }
    })
  }
  async function live(id, pairId, actor, hands) {
    if (hands && !actor?.isAdmin) throw new ProductError(403, 'Administrator access required')
    const match = await pairing(id, pairId)
    const found = await engine(match.table_id, hands)
    const snapshot = found?.snapshot
    if (!snapshot)
      return publicSpectatorBoard({
        tableId: match.table_id,
        status: match.completed ? 'finished' : 'waiting',
      })
    if (snapshot.tableId !== match.table_id) throw missing()
    roster(snapshot.view?.players, match)
    const frame = { ...snapshot, players: roster(snapshot.players, match) }
    return hands ? privateSpectatorBoard(frame) : publicSpectatorBoard(frame)
  }

  // Recheck the retained match before using cached frames. A retired object cannot
  // become accessible through the cache after its last retaining account expires.
  const cache = new Map()
  const loading = new Map()
  async function frames(game) {
    const key = game.id + '/' + game.checksum
    if (cache.has(key)) return cache.get(key)
    if (loading.has(key)) return loading.get(key)
    if (loading.size >= 2) throw new ProductError(503, 'Replay storage is busy. Try again shortly.')
    const pending = archive
      .readReviewArchive(game)
      .then((records) => {
        const playable = []
        const lines = []
        const seen = new Set()
        for (const record of records) {
          const note = record.kind === 'line' && lineText(record)
          if (note && isUuid(record.actorPlayerId) && typeof record.commandId === 'string' &&
              record.commandId.length > 0 && record.commandId.length <= 120) {
            const lineId = game.id + ':' + record.actorPlayerId + ':' + record.commandId
            if (!seen.has(lineId)) {
              seen.add(lineId)
              lines.push({ lineId, playerId: record.actorPlayerId, ...note, turn: record.turn,
                at: record.at ?? Number(game.started_at) + record.t })
            }
          }
          if (record.view?.players?.length === 2) {
            playable.push({ record, lineCount: lines.length })
          }
        }
        // A terminal play may be recorded after the final board update.
        if (playable.length) playable.at(-1).lineCount = lines.length
        const indexed = { playable, lines }
        if (cache.size >= 2) cache.delete(cache.keys().next().value)
        cache.set(key, indexed)
        return indexed
      })
      .finally(() => loading.delete(key))
    loading.set(key, pending)
    return pending
  }

  async function replay(id, pairId, actor, query) {
    const match = await pairing(id, pairId)
    if (!match.completed && !actor?.isAdmin) throw missing()
    const { rows: games } = await pool.query(
      `SELECT g.id,g.object_key,g.checksum,g.game_number,g.started_at FROM matches m
      JOIN games g ON m.id=g.match_id
      WHERE (m.id=$2 OR ($2 IS NULL AND m.table_id IN
        (SELECT table_id FROM tournament_pairing_tables WHERE pairing_id=$1)))
      AND g.object_key IS NOT NULL AND EXISTS(SELECT FROM match_history_retention_window r WHERE r.match_id=m.id)
      ORDER BY g.game_number`,
      [match.id, match.match_id],
    )
    const gameId = query.get('gameId')
    if (!gameId) {
      const result = []
      for (const game of games) result.push({ gameId: game.id, frameCount: (await frames(game)).playable.length })
      return { games: result }
    }
    const game = games.find((g) => g.id === gameId)
    const value = query.get('frame') ?? '0'
    if (!game || !/^\d{1,9}$/.test(value)) throw missing()
    const { playable, lines } = await frames(game)
    const frame = playable[Number(value)]
    if (!frame) throw missing()
    const f = frame.record
    const players = roster(f.view.players, match)
    const hands = Object.fromEntries(
      players.map((p) => [
        p.playerId,
        f.hands?.[p.name] ?? f.hands?.[p.playerId] ?? f.review?.seatViews?.[p.playerId]?.myHand ?? {},
      ]),
    )
    return privateSpectatorBoard({
      tableId: match.table_id,
      gameId,
      status: 'playing',
      players,
      view: f.view,
      hands,
      lines: lines.slice(Math.max(0, frame.lineCount - 100), frame.lineCount),
      revision: Number(value),
    })
  }
  return { live, replay }
}
