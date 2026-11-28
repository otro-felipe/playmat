import { createHash } from 'node:crypto'
import { authorizeTournamentCreator, authorizeTournamentManagement, requireTournamentAdmin } from './tournament-access.mjs'
import { ProductError, getDeck, isUuid, normalizeFormat, transaction } from './decks.mjs'
import { lockHistoryRetention } from './history-retention.mjs'
import { tournamentStructure } from './tournament-rules.mjs'
import { declaredRuntime, readPlayerRuntime } from './player-runtime.mjs'
import {
  minute,
  roundDurationMs,
  attendanceSampleWindowMs,
  timestamp,
  tournamentRow,
  entrants,
  pairings,
  summary,
  view,
  startRound,
  advanceIfComplete,
} from './tournament-state.mjs'

function checkSeat(actor) {
  if (!actor?.accountId || (actor.agent && !actor.playerId))
    throw new ProductError(403, 'Choose your registered player profile')
}
function integral(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new ProductError(400, 'Invalid ' + label)
  return value
}
const sameSeat = (p, actor) => p.ownerId === actor.accountId && p.playerId === (actor.playerId ?? null)
function validId(id) {
  if (!isUuid(id)) throw new ProductError(404, 'Tournament not found')
}

function structureSettings(input, format) {
  const template = input.template ?? 'attendance',
    cut = input.cut ?? 'auto'
  if (!['attendance', 'worlds'].includes(template) || !['auto', 'none'].includes(cut))
    throw new ProductError(400, 'Choose a tournament structure')
  if (template === 'worlds' && (format !== 'Standard' || cut !== 'auto'))
    throw new ProductError(400, 'Worlds uses Standard and a Top 8')
  const rounds = input.swissRounds == null ? null : integral(input.swissRounds, 1, 14, 'number of Swiss rounds')
  if (rounds != null && (template === 'worlds' || cut !== 'none'))
    throw new ProductError(400, 'Custom rounds are available for rounds-only events')
  return { template, cut, rounds }
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function creationSettings(input) {
  const name = String(input.name ?? '').trim(),
    format = normalizeFormat(input.format)
  if (!name || name.length > 100 || !format)
    throw new ProductError(400, 'Choose a tournament name and Constructed format')
  const { template, cut, rounds } = structureSettings(input, format)
  if (template === 'worlds' && input.coaching === true) throw new ProductError(400, 'Worlds requires autonomous play')
  const capacity = integral(input.capacity ?? 32, 2, 512, 'capacity')
  const swiss = input.swissBestOf ?? 3,
    playoff = input.playoffBestOf ?? (template === 'worlds' ? 5 : 3)
  if (![3, 5].includes(swiss) || ![3, 5].includes(playoff))
    throw new ProductError(400, 'Choose best of three or five')
  const maxAgents = integral(input.maxAgentsPerOwner ?? capacity, 1, capacity, 'maximum agents per owner')
  const rest = integral(input.breakMinutes ?? 5, 0, 1440, 'round break')
  return [name, format, template, cut, capacity, rounds, swiss, playoff, maxAgents, input.coaching === true, rest]
}

export function createTournamentService(
  pool,
  {
    clock = Date.now,
    onlineMs = 90_000,
    readDeck = (db, actor, id) => getDeck(db, actor.accountId, id, null, actor.agent ? 'agent' : null),
    validateDeck,
    recordTournamentDeck,
  } = {},
) {
  async function get(id, actor = null) {
    validId(id)
    return transaction(pool, async (db) => view(db, await tournamentRow(db, id, 'FOR SHARE'), actor, clock(), onlineMs))
  }
  async function list() {
    const { rows } = await pool.query(`SELECT t.*,COUNT(e.id)::integer AS count FROM tournaments t
      LEFT JOIN tournament_entries e ON e.tournament_id=t.id WHERE t.voided_at IS NULL
      GROUP BY t.id ORDER BY t.created_at DESC,t.id`)
    return rows.map((t) => ({ ...summary(t), registeredCount: t.count }))
  }
  async function create(actor, input) {
    return transaction(pool, async (db) => {
      await authorizeTournamentCreator(db, actor)
      const { requestId } = input
      if ((requestId !== undefined || actor.agent) && !(typeof requestId === 'string' && uuidV4.test(requestId))) {
        throw new ProductError(400, 'Provide a UUID version 4 creation request ID')
      }
      const settings = creationSettings(input)
      // Fingerprint the initial, normalized settings; organizers can edit the structure after creation.
      const hash = requestId ? createHash('sha256').update(JSON.stringify(settings)).digest('hex') : null
      const { rows: [created] } = await db.query(
        `INSERT INTO tournaments(organizer_id,creation_request_id,creation_request_hash,created_at,
          name,format,template,cut,capacity,requested_rounds,swiss_best_of,playoff_best_of,max_agents_per_owner,coaching,break_minutes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (organizer_id,creation_request_id) WHERE creation_request_id IS NOT NULL DO NOTHING RETURNING *`,
        [actor.accountId, requestId ?? null, hash, clock(), ...settings],
      )
      if (created) return view(db, created, actor, clock(), onlineMs)
      const { rows: [previous] } = await db.query(
        'SELECT * FROM tournaments WHERE organizer_id=$1 AND creation_request_id=$2 FOR SHARE',
        [actor.accountId, requestId],
      )
      if (previous?.creation_request_hash !== hash)
        throw new ProductError(409, 'That creation request ID belongs to different tournament settings')
      return view(db, previous, actor, clock(), onlineMs)
    })
  }
  async function join(id, actor, { deckId }) {
    validId(id)
    checkSeat(actor)
    return transaction(pool, async (db) => {
      const t = await tournamentRow(db, id, 'FOR UPDATE')
      if (t.status !== 'registration') throw new ProductError(409, 'Registration has closed')
      const players = await entrants(db, id),
        existing = players.find((p) => sameSeat(p, actor))
      if (!existing && players.length >= t.capacity) throw new ProductError(409, 'Tournament is full')
      if (
        !existing &&
        actor.playerId &&
        !actor.ownerIsAdmin &&
        !actor.isAdmin &&
        players.filter((p) => p.playerId && p.ownerId === actor.accountId).length >= t.max_agents_per_owner
      )
        throw new ProductError(409, 'This owner has reached the agent limit')
      const deck = await readDeck(db, actor, deckId)
      if (!deck || normalizeFormat(deck.format) !== t.format || !deck.data?.cards?.length)
        throw new ProductError(400, 'Select a legal deck for the tournament format')
      await validateDeck?.(db, actor, deck, t.format)
      const name = actor.displayName ?? actor.engineName ?? actor.username
      const { provider, model, reasoningEffort } = await readPlayerRuntime(db, actor)
      const {
        rows: [entry],
      } = await db.query(
        `INSERT INTO tournament_entries(tournament_id,owner_id,player_id,name,owner_name,engine_name,deck_id,
        deck_revision,deck_name,last_seen,provider,model,reasoning_effort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(tournament_id,engine_name) DO UPDATE SET deck_id=EXCLUDED.deck_id,deck_revision=EXCLUDED.deck_revision,
        deck_name=EXCLUDED.deck_name WHERE tournament_entries.owner_id=EXCLUDED.owner_id AND tournament_entries.player_id IS NOT DISTINCT FROM EXCLUDED.player_id RETURNING id`,
        [
          id,
          actor.accountId,
          actor.playerId ?? null,
          name,
          actor.username,
          actor.engineName ?? actor.username,
          deckId,
          deck.revision,
          deck.name,
          actor.agent ? null : clock(),
          provider, model, reasoningEffort,
        ],
      )
      if (!entry) throw new ProductError(409, 'The seat is already occupied')
      await db.query('DELETE FROM tournament_entry_cards WHERE entry_id=$1', [entry.id])
      for (const zone of ['cards', 'sideboard']) {
        const cards = deck.data[zone] ?? []
        if (cards.length)
          await db.query(
            `INSERT INTO tournament_entry_cards(entry_id,zone,position,card_name,amount,set_code,card_number)
          SELECT $1,$2,ord,value->>'cardName',(value->>'amount')::integer,value->>'setCode',value->>'cardNumber'
          FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS c(value,ord)`,
            [entry.id, zone, JSON.stringify(cards)],
          )
      }
      await recordTournamentDeck?.(db,entry.id)
      return { tournamentId: id, entryId: entry.id, state: 'registered', status: 'registered' }
    })
  }
  async function wait(id, actor) {
    validId(id)
    checkSeat(actor)
    return transaction(pool, async (db) => {
      const t = await tournamentRow(db, id, 'FOR SHARE'),
        now = clock()
      const {
        rows: [p],
      } = await db.query(
        `SELECT id,state,deck_name,deck_revision,NULLIF(opening_archetype,'Other') AS archetype
        FROM tournament_entries WHERE tournament_id=$1 AND owner_id=$2
        AND player_id IS NOT DISTINCT FROM $3::uuid`,
        [id, actor.accountId, actor.playerId ?? null],
      )
      if (!p) throw new ProductError(404, 'This player is not registered')
      const {
        rows: [m],
      } = await db.query(
        `SELECT * FROM tournament_pairings WHERE tournament_id=$1 AND round_number=$2
        AND (entry_a=$3 OR entry_b=$3)`,
        [id, t.round_number, p.id],
      )
      const base = {
        tournamentId: id,
        entryId: p.id,
        registeredDeck: { name: p.deck_name, revision: p.deck_revision, archetype: p.archetype },
        roundNumber: t.round_number,
        nextRoundAt: timestamp(t.next_round_at),
        nextSessionAt: timestamp(t.next_session_at),
        online: true,
      }
      let state = t.status
      if (['cancelled', 'finished'].includes(t.status)) state = t.status
      else if (['eliminated', 'disqualified', 'absent'].includes(p.state)) state = p.state
      else if (t.status === 'playing') {
        if (!m) state = p.state === 'qualified' ? 'qualified' : 'waiting'
        else if (!m.entry_b) state = 'bye'
        else if (m.completed) state = 'waiting'
        else if (!m.table_id) state = 'preparing'
        else state = 'table'
      }
      const unavailable =
        actor.agent && (actor.ownsReservation === false || (actor.activeTableId && actor.activeTableId !== m?.table_id))
      if (unavailable && ['registration', 'playing', 'break'].includes(t.status)) {
        if (actor.ownsReservation !== false)
          await db.query('UPDATE tournament_entries SET last_seen=NULL WHERE id=$1', [p.id])
        return { ...base, online: false, state: 'busy', status: 'busy', tableId: null }
      }
      await db.query('UPDATE tournament_entries SET last_seen=$2 WHERE id=$1', [p.id, now])
      const opponentId = m?.entry_a === p.id ? m?.entry_b : m?.entry_a
      const opponent = opponentId
        ? (await db.query(`SELECT id,name,owner_name AS owner,provider,model,reasoning_effort AS "reasoningEffort"
          FROM tournament_entries WHERE id=$1`, [opponentId]))
            .rows[0]
        : null
      return {
        ...base,
        state,
        status: state,
        pairingId: m?.id ?? null,
        tableId: state === 'table' ? m.table_id : null,
        opponent: opponent && withRuntime(opponent),
        bestOf: m?.best_of ?? null,
        deadlineAt: timestamp(m?.deadline_at),
        championId: t.champion_id,
      }
    })
  }
  async function startWithAttendance(db, t, now, expectedPlayers) {
    const players = await entrants(db, t.id)
    const present = players.filter((p) => p.lastSeen != null && now - p.lastSeen <= onlineMs)
    if (expectedPlayers !== undefined && present.length !== expectedPlayers)
      throw new ProductError(409, 'The connected player count changed')
    if (present.length < 2 || (t.template === 'worlds' && present.length <= 8))
      throw new ProductError(409, 'Too few connected players for this structure')
    const { swissRounds, cutSize } = tournamentStructure(
      { template: t.template, cut: t.cut, swissRounds: t.requested_rounds },
      present.length,
    )
    await db.query("UPDATE tournament_entries SET state='absent' WHERE tournament_id=$1", [t.id])
    await db.query(
      `UPDATE tournament_entries e SET state='active',seed=s.ord FROM
        unnest($2::uuid[]) WITH ORDINALITY s(id,ord) WHERE e.tournament_id=$1 AND e.id=s.id`,
      [t.id, present.map((p) => p.id)],
    )
    const {
      rows: [next],
    } = await db.query('UPDATE tournaments SET rounds_total=$2,cut_size=$3 WHERE id=$1 RETURNING *', [
      t.id,
      swissRounds,
      cutSize,
    ])
    await startRound(db, next, now)
  }
  async function start(id, actor, input) {
    validId(id)
    if (typeof input.requestId !== 'string' || !uuidV4.test(input.requestId)
      || Object.keys(input).some(key => key !== 'requestId' && key !== 'expectedPlayers')) {
      throw new ProductError(400, 'Provide a UUID version 4 start request ID and the expected number of connected players')
    }
    const requestId = input.requestId.toLowerCase()
    const playerCount = integral(input.expectedPlayers, 2, 512, 'expected connected player count')
    return transaction(pool, async (db) => {
      await authorizeTournamentManagement(db, actor)
      const t = await tournamentRow(db, id, 'FOR UPDATE')
      if (t.organizer_id !== actor.accountId) throw new ProductError(404, 'Tournament not found')
      // Registration, check-ins and start all lock the tournament row. A concurrent
      // browser start or attendance change is reconciled before creating any pairings.
      let startedAt
      if (t.start_request_id === requestId && t.start_player_count === playerCount) {
        startedAt = timestamp(t.start_requested_at)
      } else {
        if (t.status !== 'registration') throw new ProductError(409, 'This tournament has already left registration')
        startedAt = clock()
        await startWithAttendance(db, t, startedAt, playerCount)
        await db.query('UPDATE tournaments SET start_request_id=$2,start_player_count=$3,start_requested_at=$4 WHERE id=$1', [
          t.id, requestId, playerCount, startedAt,
        ])
      }
      return { tournamentId: t.id, requestId, started: true, playerCount, roundNumber: 1, startedAt }
    })
  }
  async function stop(id, actor, input) {
    validId(id)
    if (typeof input.requestId !== 'string' || !uuidV4.test(input.requestId)
      || Object.keys(input).some(key => key !== 'requestId' && key !== 'expectedRound')) {
      throw new ProductError(400, 'Provide a UUID version 4 stop request ID and the expected round')
    }
    const requestId = input.requestId.toLowerCase()
    const expectedRound = integral(input.expectedRound, 0, 32, 'expected round')
    return transaction(pool, async (db) => {
      await authorizeTournamentManagement(db, actor)
      const t = await tournamentRow(db, id, 'FOR UPDATE')
      if (t.organizer_id !== actor.accountId) throw new ProductError(404, 'Tournament not found')
      if (t.round_number !== expectedRound) throw new ProductError(409, 'The tournament round changed')
      let stoppedAt = timestamp(t.stop_requested_at)
      if (t.stop_request_id !== requestId) {
        if (['finished', 'cancelled'].includes(t.status)) throw new ProductError(409, 'This tournament is already closed')
        stoppedAt = clock()
        // Fence signed scores and restore before reading the final set of unfinished pairings.
        await db.query('SELECT id FROM tournament_pairings WHERE tournament_id=$1 AND NOT completed FOR UPDATE', [t.id])
        await db.query(`UPDATE tournament_pairings p SET result_reason='cancelled',deadline_at=NULL,
          attendance_observed_at=NULL WHERE p.tournament_id=$1 AND NOT p.completed
          AND NOT EXISTS (SELECT FROM tournament_engine_results r
            JOIN tournament_entries a ON a.id=p.entry_a JOIN tournament_entries b ON b.id=p.entry_b
            WHERE r.pairing_id=p.id AND r.seat_a=lower(a.engine_name) AND r.seat_b=lower(b.engine_name)
            AND tournament_pairing_for_table(r.table_id)=p.id)`, [t.id])
        await db.query(`UPDATE tournaments SET status='cancelled',deadline_at=NULL,next_round_at=NULL,next_session_at=NULL,
          stop_request_id=$2,stop_requested_at=$3 WHERE id=$1`, [t.id, requestId, stoppedAt])
      }
      const { rows: [cleanup] } = await db.query(`SELECT count(*)::int AS count FROM tournament_pairings
        WHERE tournament_id=$1 AND NOT completed AND NOT cleanup_done`, [t.id])
      return { tournamentId: t.id, requestId, expectedRound, stopped: true, stoppedAt, pendingTables: cleanup.count }
    })
  }
  async function voidTournament(id, actor, input) {
    validId(id)
    const { requestId: supplied, expectedStatus } = input
    if (typeof supplied !== 'string' || !uuidV4.test(supplied) || expectedStatus !== 'finished'
      || Object.keys(input).some(key => key !== 'requestId' && key !== 'expectedStatus')) {
      throw new ProductError(400, 'Provide a UUID version 4 annulment request ID and expectedStatus finished')
    }
    const requestId = supplied.toLowerCase()
    return transaction(pool, async db => {
      await lockHistoryRetention(db)
      if (actor?.agent) await authorizeTournamentManagement(db, actor)
      else {
        requireTournamentAdmin(actor)
        if (!actor.browserSession) throw new ProductError(403, 'A signed-in administrator is required')
        const { rowCount } = await db.query('SELECT id FROM accounts WHERE id=$1 AND enabled AND tournament_admin FOR SHARE', [actor.accountId])
        if (!rowCount) throw new ProductError(403, 'Tournament administration is unavailable')
      }
      const t = await tournamentRow(db, id, 'FOR UPDATE')
      if (t.organizer_id !== actor.accountId) throw new ProductError(404, 'Tournament not found')
      let voidedAt = timestamp(t.voided_at)
      if (t.void_request_id !== requestId) {
        if (t.status !== expectedStatus || t.voided_at !== null) throw new ProductError(409, 'This tournament is not eligible for annulment')
        // Fence late results and checkpoint restore before relying on the archived links.
        await db.query('SELECT id FROM tournament_pairings WHERE tournament_id=$1 FOR UPDATE', [t.id])
        const { rows: [{ unsettled }] } = await db.query(`WITH event_matches AS (
          SELECT match_id AS id FROM tournament_pairings WHERE tournament_id=$1 AND match_id IS NOT NULL
          UNION SELECT m.id FROM tournament_pairings p JOIN tournament_pairing_tables physical ON physical.pairing_id=p.id
            JOIN matches m ON m.table_id=physical.table_id WHERE p.tournament_id=$1
        ) SELECT EXISTS(SELECT 1 FROM tournament_pairings WHERE tournament_id=$1 AND NOT completed)
          OR EXISTS(SELECT 1 FROM event_matches e JOIN matches m ON m.id=e.id WHERE m.status='active')
          OR EXISTS(SELECT 1 FROM event_matches e JOIN games g ON g.match_id=e.id WHERE g.status='active') AS unsettled`, [t.id])
        if (unsettled) throw new ProductError(409, 'This tournament still has unfinished pairings or active games')
        voidedAt = clock()
        await db.query(`UPDATE tournaments SET status='cancelled',champion_id=NULL,deadline_at=NULL,
          next_round_at=NULL,next_session_at=NULL,void_request_id=$2,voided_at=$3 WHERE id=$1`, [t.id, requestId, voidedAt])
      }
      return { tournamentId: t.id, requestId, expectedStatus, status: 'cancelled', voidedAt }
    })
  }
  async function action(id, actor, input) {
    validId(id)
    requireTournamentAdmin(actor)
    return transaction(pool, async (db) => {
      let t = await tournamentRow(db, id, 'FOR UPDATE')
      const now = clock()
      if (input.action === 'start' && t.status === 'registration') {
        await startWithAttendance(db, t, now)
      } else if (input.action === 'structure' && t.status === 'registration') {
        const { template, cut, rounds } = structureSettings(input, t.format)
        const changingTemplate = template !== t.template
        await db.query(
          `UPDATE tournaments SET template=$2,cut=$3,requested_rounds=$4,swiss_best_of=$5,playoff_best_of=$6 WHERE id=$1`,
          [
            id,
            template,
            cut,
            rounds,
            changingTemplate ? 3 : t.swiss_best_of,
            changingTemplate ? (template === 'worlds' ? 5 : 3) : t.playoff_best_of,
          ],
        )
      } else if (input.action === 'extend' && t.status === 'break') {
        const amount = integral(input.minutes, 1, 1440, 'extension')
        await db.query(
          'UPDATE tournaments SET next_round_at=GREATEST(next_round_at,$2::bigint)+$3::bigint WHERE id=$1',
          [id, now, amount * minute],
        )
      } else if (input.action === 'pause' && ['break', 'paused'].includes(t.status)) {
        const next = input.nextSessionAt == null ? null : Number(input.nextSessionAt)
        if (next != null && (!Number.isSafeInteger(next) || next < now))
          throw new ProductError(400, 'Invalid next session time')
        await db.query("UPDATE tournaments SET status='paused',next_round_at=NULL,next_session_at=$2 WHERE id=$1", [
          id,
          next,
        ])
      } else if (input.action === 'resume' && t.status === 'paused') {
        await startRound(db, t, now)
      } else if (input.action === 'cancel' && ['registration', 'break', 'paused'].includes(t.status)) {
        await db.query(
          "UPDATE tournaments SET status='cancelled',next_round_at=NULL,next_session_at=NULL WHERE id=$1",
          [id],
        )
      } else throw new ProductError(409, 'This action is not available in the current tournament state')
      t = await tournamentRow(db, id)
      return view(db, t, actor, now, onlineMs)
    })
  }
  async function bindTable(id, pairingId, tableId) {
    if (![id, pairingId, tableId].every(isUuid)) throw new ProductError(400, 'Invalid table assignment')
    return transaction(pool, async (db) => {
      await tournamentRow(db, id, 'FOR UPDATE')
      const { rowCount } = await db.query(
        `UPDATE tournament_pairings SET opened_at=CASE WHEN table_id IS NULL THEN $4 ELSE opened_at END,
        deadline_at=CASE WHEN table_id IS NULL AND deadline_at IS NOT NULL AND EXISTS
          (SELECT FROM tournament_pairing_tables WHERE pairing_id=$2 AND failed_start_retried_at IS NOT NULL)
          THEN $4::bigint + $5::bigint ELSE deadline_at END,
        cleanup_done=CASE WHEN result_reason='cancelled' AND table_id IS DISTINCT FROM $3 THEN false ELSE cleanup_done END,
        table_id=$3 WHERE tournament_id=$1 AND id=$2 AND (table_id=$3 OR (table_id IS NULL AND NOT completed))
        AND NOT EXISTS (SELECT FROM tournament_pairing_tables WHERE table_id=$3 AND failed_start_retried_at IS NOT NULL)`,
        [id, pairingId, tableId, clock(), roundDurationMs],
      )
      if (!rowCount) throw new ProductError(409, 'This pairing has a different table or has finished')
      return { pairingId, tableId }
    })
  }
  async function report(id, pairingId, result) {
    return transaction(pool, async (db) => {
      const t = await tournamentRow(db, id, 'FOR UPDATE')
      const {
        rows: [m],
      } = await db.query('SELECT * FROM tournament_pairings WHERE id=$1 AND tournament_id=$2 FOR UPDATE', [pairingId, id])
      if (!m || !m.entry_b || !m.table_id || m.table_id !== result.tableId)
        throw new ProductError(409, 'Tournament table does not match')
      if (m.result_reason === 'cancelled') return { recorded: false }
      const a = integral(result.winsA, 0, Math.ceil(m.best_of / 2), 'game wins'),
        b = integral(result.winsB, 0, Math.ceil(m.best_of / 2), 'game wins')
      const draws = integral(result.draws ?? 0, 0, 10000, 'game draws')
      let winner = a > b ? m.entry_a : b > a ? m.entry_b : null
      if (result.winnerEngineName) {
        const {
          rows: [seat],
        } = await db.query(
          'SELECT id FROM tournament_entries WHERE id=ANY($1::uuid[]) AND lower(engine_name)=lower($2)',
          [[m.entry_a, m.entry_b], result.winnerEngineName],
        )
        if (!seat) throw new ProductError(409, 'Match winner is not assigned to this table')
        winner = seat.id
      }
      if ((m.stage === 'playoffs' && !winner) || (a === b && a === Math.ceil(m.best_of / 2)))
        throw new ProductError(409, 'Invalid match score')
      // The pairing lock serializes the final score with late check-ins. Release its seats
      // across physical restores, using the current binding so a later assignment survives.
      await db.query(
        `DELETE FROM player_table_reservations r USING tournament_entries e,tournament_pairing_tables physical
         WHERE physical.pairing_id=$1 AND r.table_id=physical.table_id
           AND r.player_id=e.player_id AND e.id IN ($2,$3)`,
        [m.id, m.entry_a, m.entry_b],
      )
      if (m.completed) {
        if (
          m.wins_a !== a ||
          m.wins_b !== b ||
          m.draws !== draws ||
          m.winner_entry !== winner ||
          (result.matchId && m.match_id && result.matchId !== m.match_id)
        )
          throw new ProductError(409, 'A different result was already recorded')
        return { recorded: true }
      }
      if (result.disqualified) {
        const removed = await db.query(
          `UPDATE tournament_entries SET state='disqualified' WHERE id=ANY($1::uuid[])
          AND lower(engine_name)=lower($2) RETURNING id`,
          [[m.entry_a, m.entry_b], result.disqualified],
        )
        if (!removed.rowCount) throw new ProductError(409, 'Disqualified player is not in this match')
        const lost = winner && removed.rows[0].id !== winner
        if (!lost) throw new ProductError(409, 'Disqualified player cannot win or draw')
      }
      await db.query(
        `UPDATE tournament_pairings SET wins_a=$2,wins_b=$3,draws=$4,completed=true,
        match_id=$5,result_reason=$6,winner_entry=$7 WHERE id=$1`,
        [m.id, a, b, draws, result.matchId ?? null, result.disqualified ? 'afk' : 'played', winner],
      )
      await advanceIfComplete(db, t, clock())
      return { recorded: true }
    })
  }
  async function acceptTable(id, pairingId, tableId, engineName) {
    if (![id, pairingId, tableId].every(isUuid) || !engineName) throw new ProductError(400, 'Invalid table acceptance')
    const { rowCount } = await pool.query(
      `UPDATE tournament_pairings p SET
      ack_a=CASE WHEN e.id=p.entry_a THEN COALESCE(p.ack_a,$5) ELSE p.ack_a END,
      ack_b=CASE WHEN e.id=p.entry_b THEN COALESCE(p.ack_b,$5) ELSE p.ack_b END
      FROM tournament_entries e WHERE p.tournament_id=$1 AND p.id=$2 AND p.table_id=$3
      AND e.id IN (p.entry_a,p.entry_b) AND lower(e.engine_name)=lower($4) AND NOT p.completed`,
      [id, pairingId, tableId, engineName, clock()],
    )
    return { accepted: rowCount > 0 }
  }
  async function beginTableLaunch(id, pairingId, tableId) {
    // Set the restored clock once when both pilots first confirm the new table.
    // A repeated launch RPC retains the same deadline.
    const { rows: [pair] } = await pool.query(
      `UPDATE tournament_pairings SET deadline_at=CASE
        WHEN launch_requested_at IS NULL AND deadline_at IS NOT NULL AND EXISTS
          (SELECT FROM tournament_pairing_tables WHERE pairing_id=$2 AND failed_start_retried_at IS NOT NULL)
        THEN $4::bigint + $5::bigint ELSE deadline_at END,
        launch_requested_at=COALESCE(launch_requested_at,$4::bigint)
       WHERE tournament_id=$1 AND id=$2 AND table_id=$3 AND NOT launched AND NOT completed
         AND result_reason IS DISTINCT FROM 'cancelled'
         AND ack_a IS NOT NULL AND ack_b IS NOT NULL RETURNING deadline_at AS "deadlineAt"`,
      [id, pairingId, tableId, clock(), roundDurationMs],
    )
    return pair ? { deadlineAt: timestamp(pair.deadlineAt) } : null
  }
  async function markLaunched(id, pairingId, tableId) {
    await pool.query(
      'UPDATE tournament_pairings SET launched=true WHERE tournament_id=$1 AND id=$2 AND table_id=$3 AND NOT launched AND NOT completed',
      [id, pairingId, tableId],
    )
  }
  async function observeWaitingTable(id, pairingId, tableId) {
    await pool.query(
      `UPDATE tournament_pairings SET attendance_observed_at=$4,
        attendance_elapsed_ms=attendance_elapsed_ms+CASE
          WHEN $4::bigint-attendance_observed_at BETWEEN 0 AND $5 THEN $4-attendance_observed_at ELSE 0 END
       WHERE tournament_id=$1 AND id=$2 AND table_id=$3 AND NOT launched AND NOT completed
         AND (attendance_observed_at IS NULL OR attendance_observed_at<$4)`,
      [id, pairingId, tableId, clock(), attendanceSampleWindowMs],
    )
  }
  async function suspendWaitingTable(id, pairingId, tableId) {
    await pool.query(
      `UPDATE tournament_pairings SET attendance_observed_at=NULL WHERE tournament_id=$1 AND id=$2 AND table_id=$3
        AND NOT launched AND NOT completed AND attendance_observed_at IS NOT NULL`,
      [id, pairingId, tableId],
    )
  }
  async function missTable(id, pairingId, tableId, engineName) {
    await pool.query(
      `UPDATE tournament_pairings p SET
      ack_a=CASE WHEN e.id=p.entry_a THEN NULL ELSE p.ack_a END,
      ack_b=CASE WHEN e.id=p.entry_b THEN NULL ELSE p.ack_b END
      FROM tournament_entries e WHERE p.tournament_id=$1 AND p.id=$2 AND p.table_id=$3 AND NOT p.launched AND NOT p.completed
      AND lower(e.engine_name)=lower($4) AND ((p.entry_a=e.id AND ack_a IS NOT NULL) OR (p.entry_b=e.id AND ack_b IS NOT NULL))`,
      [id, pairingId, tableId, engineName],
    )
  }
  async function closedTables() {
    const { rows } =
      await pool.query(`SELECT tournament_id AS "tournamentId",id AS "pairingId",table_id AS "tableId",result_reason AS reason
      FROM tournament_pairings WHERE NOT cleanup_done AND (result_reason='cancelled'
      OR (completed AND table_id IS NOT NULL AND result_reason IN ('double_forfeit','no_show'))) ORDER BY opened_at`)
    return rows
  }
  async function cleanedTable(id, pairingId, tableId) {
    await transaction(pool, async db => {
      const { rows: [pair] } = await db.query(`UPDATE tournament_pairings SET cleanup_done=true
        WHERE tournament_id=$1 AND id=$2 AND table_id IS NOT DISTINCT FROM $3
        AND (completed OR result_reason='cancelled') RETURNING entry_a,entry_b,result_reason`, [id, pairingId, tableId])
      if (!pair || !tableId) return
      await db.query(`DELETE FROM player_table_reservations WHERE table_id=$1 AND player_id IN
        (SELECT player_id FROM tournament_entries WHERE id IN ($2,$3))`, [tableId, pair.entry_a, pair.entry_b])
      if (pair.result_reason === 'cancelled') {
        await db.query(`UPDATE games g SET status='interrupted',archive_state='partial' FROM matches m
          WHERE g.match_id=m.id AND m.table_id=$1 AND g.status='active'`, [tableId])
        await db.query(`UPDATE matches SET status='interrupted' WHERE table_id=$1 AND status='active'`, [tableId])
      }
    })
  }
  async function pendingTables() {
    const { rows } =
      await pool.query(`SELECT m.id AS "pairingId",m.tournament_id AS "tournamentId",t.format,t.template,m.stage,m.best_of AS "bestOf",
      t.status='cancelled' AS stopped,
      m.table_id AS "tableId",m.deadline_at AS "deadlineAt",a.id AS aid,b.id AS bid,
      a.engine_name AS an,b.engine_name AS bn,a.owner_id AS ao,b.owner_id AS bo,a.player_id AS ap,b.player_id AS bp,
      a.deck_id AS ad,b.deck_id AS bd,a.deck_revision AS ar,b.deck_revision AS br,
      CASE WHEN m.stage='playoffs' THEN CASE WHEN a.qualified_seed<b.qualified_seed THEN a.engine_name ELSE b.engine_name END END AS "playDrawChooser"
      FROM tournament_pairings m JOIN tournaments t ON t.id=m.tournament_id
      JOIN tournament_entries a ON a.id=m.entry_a JOIN tournament_entries b ON b.id=m.entry_b
      WHERE NOT m.completed AND (t.status='playing' OR (t.status='cancelled' AND m.result_reason IS NULL
        AND EXISTS (SELECT FROM tournament_engine_results r WHERE r.pairing_id=m.id))) ORDER BY t.created_at,m.number`)
    function seat(row, prefix) {
      return {
        entryId: row[prefix + 'id'],
        engineName: row[prefix + 'n'],
        accountId: row[prefix + 'o'],
        playerId: row[prefix + 'p'],
        deckId: row[prefix + 'd'],
        revision: row[prefix + 'r'],
      }
    }
    return rows.map((r) => ({
      tournamentId: r.tournamentId,
      pairingId: r.pairingId,
      stopped: r.stopped,
      format: r.format,
      template: r.template,
      stage: r.stage,
      bestOf: r.bestOf,
      tableId: r.tableId,
      deadlineAt: timestamp(r.deadlineAt),
      sideboardAfterGame: r.template === 'worlds' && r.stage === 'playoffs' && r.bestOf === 5 ? 2 : 1,
      playDrawChooser: r.playDrawChooser,
      playerA: seat(r, 'a'),
      playerB: seat(r, 'b'),
    }))
  }
  async function tick() {
    const now = clock()
    const { rows } = await pool.query(
      `SELECT id FROM tournaments t WHERE (status='break' AND next_round_at<=$1)
      OR (status='playing' AND EXISTS (SELECT 1 FROM tournament_pairings p WHERE p.tournament_id=t.id AND p.table_id IS NOT NULL
      AND NOT p.completed AND NOT p.launched AND (p.ack_a IS NULL OR p.ack_b IS NULL)
      AND p.attendance_elapsed_ms>=$2 AND p.attendance_observed_at>=$3))`,
      [now, 10 * minute, now - attendanceSampleWindowMs],
    )
    for (const { id } of rows)
      await transaction(pool, async (db) => {
        const t = await tournamentRow(db, id, 'FOR UPDATE')
        if (t.status === 'break' && Number(t.next_round_at) <= now) return startRound(db, t, now)
        if (t.status !== 'playing') return
        const matches = (await pairings(db, id)).filter(
          (m) => !m.completed && m.tableId && m.attendanceElapsed >= 10 * minute &&
            m.attendanceObserved >= now - attendanceSampleWindowMs,
        )
        for (const m of matches) {
          const absent = [!m.ackA ? m.a : null, !m.ackB ? m.b : null].filter(Boolean)
          if (!absent.length) continue
          // Re-read under the pairing lock so a concurrently accepted seat cannot be disqualified.
          const {
            rows: [confirmed],
          } = await db.query(
            `SELECT ack_a,ack_b FROM tournament_pairings WHERE id=$1 AND NOT completed AND NOT launched
              AND attendance_elapsed_ms>=$2 AND attendance_observed_at>=$3 FOR UPDATE`,
            [m.id, 10 * minute, now - attendanceSampleWindowMs],
          )
          if (!confirmed) continue
          const missing = [!confirmed.ack_a ? m.a : null, !confirmed.ack_b ? m.b : null].filter(Boolean)
          if (!missing.length) continue
          await db.query("UPDATE tournament_entries SET state='disqualified' WHERE id=ANY($1::uuid[])", [missing])
          const wins = Math.ceil(m.bestOf / 2)
          await db.query(
            `UPDATE tournament_pairings SET completed=true,wins_a=$2,wins_b=$3,result_reason=$4,winner_entry=$5 WHERE id=$1`,
            [
              m.id,
              confirmed.ack_a ? wins : 0,
              confirmed.ack_b ? wins : 0,
              missing.length === 2 ? 'double_forfeit' : 'no_show',
              confirmed.ack_a ? m.a : confirmed.ack_b ? m.b : null,
            ],
          )
        }
        await advanceIfComplete(db, t, now)
      })
  }
  async function profile(username) {
    const {
      rows: [owner],
    } = await pool.query('SELECT id,username FROM accounts WHERE username_key=lower($1)', [username])
    if (!owner) throw new ProductError(404, 'Player not found')
    const { rows: agents } = await pool.query(
      `SELECT id,display_name AS name,provider,model,reasoning_effort AS "reasoningEffort"
       FROM player_profiles WHERE account_id=$1 AND retired_at IS NULL ORDER BY display_name,id`,
      [owner.id],
    )
    const { rows: participations } = await pool.query(
      `SELECT t.id AS "tournamentId",t.name,t.status,e.name AS "entryName",e.player_id AS "playerId",
      e.provider,e.model,e.reasoning_effort AS "reasoningEffort",
      CASE WHEN e.player_id IS NULL THEN 'human' ELSE 'agent' END AS kind,COALESCE(t.champion_id=e.id,false) AS champion
      FROM tournament_entries e JOIN tournaments t ON t.id=e.tournament_id
      WHERE e.owner_id=$1 AND e.state<>'absent' AND t.voided_at IS NULL ORDER BY t.created_at DESC,e.name`,
      [owner.id],
    )
    return { owner: owner.username, agents:agents.map(withRuntime), participations:participations.map(withRuntime),
      trophies: participations.filter((p) => p.champion).map(withRuntime) }
  }
  return {
    list,
    get,
    create,
    join,
    wait,
    start,
    stop,
    voidTournament,
    action,
    bindTable,
    acceptTable,
    beginTableLaunch,
    markLaunched,
    observeWaitingTable,
    suspendWaitingTable,
    missTable,
    closedTables,
    cleanedTable,
    report,
    pendingTables,
    tick,
    profile,
  }
}

function withRuntime({ provider, model, reasoningEffort, ...entry }) {
  return { ...entry, ...declaredRuntime({ provider, model, reasoningEffort }) }
}
