import { replayEndCauses } from './archive.mjs'
import { isUuid, normalize, ProductError } from './decks.mjs'
import { publicSpectatorBoard } from './public-spectator-board.mjs'
import { hasTournamentReplayFrame } from './tournament-replay-index.mjs'

const fields = (object, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]))

function rosterFor(view, game) {
  const roster = new Map(game.players.map(player => [player.seatId, player]))
  if (roster.size !== 2 || !Array.isArray(view.players) || view.players.length !== 2) return null
  const seen = new Set()
  const players = []
  for (const player of view.players) {
    const seatId = typeof player?.name === 'string' ? normalize(player.name) : null
    const seat = roster.get(seatId)
    if (!seat || seen.has(seatId) || !isUuid(player.playerId) || (seat.playerId && seat.playerId !== player.playerId)) return null
    seen.add(seatId)
    players.push({ name: player.name, playerId: player.playerId })
  }
  return players[0].playerId === players[1].playerId ? null : players
}

function zoneSummary(zone, limit) {
  const cards = Object.values(zone)
  return { count: cards.length, cards: cards.slice(0, limit).map(card => {
    const publicCard = fields(card, ['name', 'faceDown', 'power', 'toughness', 'tapped', 'isToken', 'isAbility'])
    if (!card.stackAbility) return publicCard
    const { kind, effect, source } = card.stackAbility
    return { ...publicCard, stackAbility: { kind, ...(effect && { effect: effect.slice(0, 280) }),
      ...(source && { source: fields(source, ['name', 'kind']) }) } }
  }) }
}

function finalBoard(record, game) {
  const players = rosterFor(record.view, game)
  if (!players) return null
  const { view } = publicSpectatorBoard({ gameId: game.id, tableId: game.table_id, status: 'finished', players, view: record.view })
  if (!Number.isSafeInteger(view?.turn) || !view.step || view.players.some(player => !Number.isSafeInteger(player.life))) return null
  return { gameState: 'finished', ...fields(view, ['turn', 'phase', 'step']), players: view.players.map(player => ({
    ...fields(player, ['playerId', 'name', 'life', 'handCount', 'libraryCount']),
    battlefield: zoneSummary(player.battlefield, 24), graveyard: zoneSummary(player.graveyard, 12), exile: zoneSummary(player.exile, 12),
  })), stack: zoneSummary(view.stack, 12) }
}

function officialOutcome(game) {
  if (game.status !== 'completed') return { kind: 'unknown' }
  const winner = typeof game.winner === 'string' && game.players.find(player => player.seatId === normalize(game.winner))
  if (winner) return { kind: 'win', winnerName: winner.name }
  return { kind: game.result === 'Game is a draw' ? 'draw' : 'unknown' }
}

export async function readTerminalReplayEvidence(records, game) {
  let cursor = -1, frame = -1, terminal = null, markerCause = null
  try {
    // The stream verifies the entire compressed checksum when exhausted. Never return an early frame.
    for await (const record of records) {
      cursor++
      if (record.kind === 'rollback') {
        terminal = null
        markerCause = null
      }
      if (record.kind === 'spectatorEnd' && record.terminal === true) {
        markerCause = replayEndCauses.has(record.cause) ? record.cause : null
      }
      if (!hasTournamentReplayFrame(record)) continue
      frame++
      if (record.terminalBoard !== true) terminal = null
      else terminal = { cursor, frame, board: finalBoard(record, game) }
    }
  } catch (error) {
    if (error instanceof ProductError) throw error
    throw new ProductError(503, 'Replay cannot be verified')
  }
  const outcome = officialOutcome(game)
  const cause = markerCause ?? (replayEndCauses.has(game.end_cause) ? game.end_cause : null)
  return terminal?.board ? {
    status: 'confirmed', outcome, cause,
    anchor: { kind: 'spectator_frame', cursor: terminal.frame },
    archiveAnchor: { kind: 'review_cursor', cursor: terminal.cursor },
    board: terminal.board,
  } : { status: frame >= 0 || cause ? 'incomplete' : 'unavailable', outcome, cause }
}
