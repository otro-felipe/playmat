import { isUuid, normalize, ProductError } from './decks.mjs'
import { publicSpectatorBoard } from './public-spectator-board.mjs'
import { privateSpectatorBoard } from './private-spectator-board.mjs'
import { publicLineExplanations } from './line-explanations.mjs'
import { tournamentReplayIndexes } from './tournament-replay-index.mjs'
import { readSpectatorEngine } from './spectators.mjs'

const missing = () => new ProductError(404, 'This tournament broadcast is unavailable')

export function createTournamentBroadcast(pool, archive, engine = readSpectatorEngine) {
  async function pairing(id, pairId) {
    if (![id, pairId].every(isUuid)) throw missing()
    const {
      rows: [row],
    } = await pool.query(
      `SELECT p.id,p.table_id,p.match_id,p.completed,p.wins_a,p.wins_b,p.draws,p.result_reason,
      CASE WHEN p.winner_entry=a.id THEN 'a' WHEN p.winner_entry=b.id THEN 'b' END AS winner_side,
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
  const indexes = tournamentReplayIndexes(archive)
  function projectFrame(match, game, record, revision) {
    const players = roster(record.view.players, match)
    const hands = Object.fromEntries(players.map(p => [p.playerId,
      record.hands?.[p.name] ?? record.hands?.[p.playerId] ?? record.review?.seatViews?.[p.playerId]?.myHand ?? {},
    ]))
    return privateSpectatorBoard({
      tableId:match.table_id, gameId:game.id, status:record.terminalBoard === true ? 'finished' : 'playing', players, view:record.view, hands, revision,
    })
  }

  async function replay(id, pairId, actor, query) {
    const match = await pairing(id, pairId)
    if (!match.completed && !actor?.isAdmin) throw missing()
    const { rows: games } = await pool.query(
      `SELECT g.id,g.object_key,g.checksum,g.game_number,g.started_at,g.status,g.archive_state,g.truncated,g.winner,g.result FROM matches m
      JOIN games g ON m.id=g.match_id
      WHERE (m.id=$2 OR ($2 IS NULL AND m.table_id IN
        (SELECT table_id FROM tournament_pairing_tables WHERE pairing_id=$1)))
      AND EXISTS(SELECT FROM match_history_retention_window r WHERE r.match_id=m.id)
      ORDER BY g.game_number,g.started_at,g.id`,
      [match.id, match.match_id],
    )
    const gameId = query.get('gameId')
    if (!gameId) {
      const result = []
      for (const game of games) {
        const {frameCount, ...ending} = game.object_key
          ? await indexes.read(game, (record, rev) => projectFrame(match, game, record, rev), true)
          : {frameCount:0, lastBoard:null, lastPublicEvent:null, terminalEvent:false, cause:null}
        const exportState = game.truncated || game.archive_state === 'partial' ||
          ['interrupted','abandoned'].includes(game.status) ? 'partial'
          : game.object_key ? 'ready' : game.archive_state === 'pending' ? 'pending' : 'unavailable'
        const outcome = game.winner && normalize(game.winner) === normalize(match.name_a) ? 'a'
          : game.winner && normalize(game.winner) === normalize(match.name_b) ? 'b'
            : game.result === 'Game is a draw' ? 'draw' : null
        result.push({gameId:game.id, gameNumber:game.game_number, frameCount, capture:{...ending, exportState, outcome}})
      }
      const officialResult = match.completed ? {
        a:match.display_a, b:match.display_b, winsA:match.wins_a, winsB:match.wins_b, draws:match.draws,
        winner:match.winner_side ?? null, reason:match.result_reason ?? null,
      } : null
      return { games: result, officialResult }
    }
    const game = games.find((g) => g.id === gameId)
    const value = query.get('frame') ?? '0'
    if (!game?.object_key || !/^\d{1,9}$/.test(value)) throw missing()
    const {board, lines} = await indexes.read(game, (record, rev) => projectFrame(match, game, record, rev), false, Number(value))
    const seats = new Map(board.players.map(p => [p.playerId, p]))
    return {...board, lines:publicLineExplanations(lines, seats, game.id)}
  }
  return { live, replay, close: indexes.close }
}
