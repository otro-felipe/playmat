import { normalize, transaction } from './decks.mjs'
import { canonicalRows, legacyKeptHand, plainReplayText } from './replay-opening.mjs'

function cardName(card) {
  const shown = card?.sourceCard ?? card
  if (
    !shown ||
    card.faceDown ||
    card.hideInfo ||
    shown.faceDown ||
    shown.hideInfo ||
    card.isToken ||
    shown.isToken ||
    card.copy ||
    shown.copy ||
    card.isCopy ||
    shown.isCopy ||
    card.isAbility
  )
    return null
  const name = shown.name
  return typeof name === 'string' && name.trim() && name.length <= 200 ? name.trim() : null
}

function knownHand(cards) {
  if (!cards || typeof cards !== 'object') return null
  const names = Object.values(cards).map(cardName)
  return names.every(Boolean) ? [...new Set(names)] : null
}

function ownLegacyHand(event, seat) {
  const name = Object.keys(event.hands ?? {}).find((key) => normalize(key) === seat)
  return name ? event.hands[name] : undefined
}

function publicCards(view, seat, seen) {
  const players = view?.players
  if (!Array.isArray(players) || !players.some((player) => normalize(player.name) === seat)) return false
  const opponents = players.filter((player) => normalize(player.name) !== seat)
  if (opponents.length !== 1) return false
  const [opponent] = opponents
  const collect = (zone, ownerZone = false) => {
    for (const card of Object.values(zone ?? {})) {
      const name = cardName(card)
      if (!name) continue
      const owner = card.ownerId ?? card.sourceCard?.ownerId
      if (owner ? owner === opponent.playerId : ownerZone) seen.add(name)
    }
  }
  for (const player of players) {
    collect(player.battlefield)
    collect(player.graveyard, player === opponent)
    collect(player.exile)
  }
  collect(view.stack)
  for (const group of view.revealed ?? []) collect(group.cards)
  for (const group of view.exiles ?? []) collect(group.cards ?? group)
  return !!(opponent.battlefield || opponent.graveyard || view.stack)
}

export function extractPerformanceEvidence(raw, game) {
  const rows = canonicalRows(raw)
  const observed = new Set()
  let coverage = false
  let opening = null
  const actor = { name: game.engine_name, playerId: game.player_id }
  for (const [index, { event }] of rows.entries()) {
    if (event.view) {
      actor.playerId ??= event.view.players?.find((player) => normalize(player.name) === game.engine_key)?.playerId
      if (publicCards(event.view, game.engine_key, observed)) coverage = true
    }
    if (actor.playerId && event.kind === 'action' && event.action === 'keep' && event.actorPlayerId === actor.playerId) {
      const confirmed = knownHand(event.decision?.cards)
      if (confirmed !== null) opening = confirmed
    }
    if (
      opening === null &&
      event.log?.messageType === 'GAME' &&
      normalize(plainReplayText(event.log.message)) === game.engine_key + ' keeps hand'
    ) {
      const hand = legacyKeptHand(rows, index, actor, (frame) => ownLegacyHand(frame, game.engine_key))
      if (hand && Object.keys(hand).length) opening = knownHand(hand)
    }
  }
  return { opening, opponent: coverage ? [...observed] : null }
}

async function storeEvidence(pool, game, evidence) {
  await transaction(pool, async (db) => {
    // An overlapping archive-retention pass can remove the parent while the
    // replay object is being read. Only insert for a surviving participant.
    const inserted = await db.query(
      `INSERT INTO game_performance_evidence(game_id,engine_key,kept_hand_known,opponent_view_known)
      SELECT game_id,engine_key,$3,$4 FROM game_players WHERE game_id=$1 AND engine_key=$2
      ON CONFLICT DO NOTHING RETURNING game_id`,
      [game.id, game.engine_key, evidence.opening !== null, evidence.opponent !== null],
    )
    if (!inserted.rowCount) return
    await db.query(
      `INSERT INTO game_performance_cards(game_id,engine_key,evidence,card_name)
      SELECT $1::uuid,$2::text,'keep',unnest($3::text[]) UNION ALL SELECT $1::uuid,$2::text,'opponent',unnest($4::text[])`,
      [game.id, game.engine_key, evidence.opening ?? [], evidence.opponent ?? []],
    )
  })
}

// The caller supplies only finalized, retained games belonging to this viewer.
// Archive reads are bounded to one object at a time per request. Concurrent
// requests for the same seat share their initial backfill.
export function evidenceLoader(pool, readArchive) {
  const pending = new Map()
  async function load(game) {
    let events
    try {
      events = await readArchive(game)
    } catch {
      // Missing or temporarily inaccessible objects do not enter card denominators.
      return { opening: null, opponent: null }
    }
    const evidence = extractPerformanceEvidence(events, game)
    await storeEvidence(pool, game, evidence)
    return evidence
  }
  async function readMissing(game) {
    if (!game.checksum || !game.object_key || game.archive_state !== 'ready') return { opening: null, opponent: null }
    const key = game.id + '/' + game.engine_key
    if (!pending.has(key))
      pending.set(
        key,
        load(game).finally(() => pending.delete(key)),
      )
    return pending.get(key)
  }

  return async (games) => {
    const evidence = new Map()
    if (!games.length) return evidence
    const { rows } = await pool.query(
      `
      SELECT e.game_id, e.kept_hand_known, e.opponent_view_known,
        ARRAY(SELECT card_name FROM game_performance_cards c WHERE (c.game_id,c.engine_key)=(e.game_id,e.engine_key) AND evidence='keep') AS opening,
        ARRAY(SELECT card_name FROM game_performance_cards c WHERE (c.game_id,c.engine_key)=(e.game_id,e.engine_key) AND evidence='opponent') AS opponent
      FROM unnest($1::uuid[], $2::text[]) AS requested(game_id,engine_key)
      JOIN game_performance_evidence e USING (game_id,engine_key)`,
      [games.map((game) => game.id), games.map((game) => game.engine_key)],
    )
    for (const row of rows) {
      evidence.set(row.game_id, {
        opening: row.kept_hand_known ? row.opening : null,
        opponent: row.opponent_view_known ? row.opponent : null,
      })
    }
    for (const game of games) {
      if (!evidence.has(game.id)) evidence.set(game.id, await readMissing(game))
    }
    return evidence
  }
}
