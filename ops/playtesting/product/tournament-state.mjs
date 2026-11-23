import { registeredDecklists } from './tournament-decklists.mjs'
import { ProductError } from './decks.mjs'
import { rankStandings, swissPairings, eliminationPairs } from './tournament-rules.mjs'

export const minute = 60_000
export const roundDurationMs = 50 * minute
// The table bridge normally polls every two seconds. A gap beyond this window
// disconnects two samples and earns no presentation time.
export const attendanceSampleWindowMs = 30_000
export const timestamp = (x) => (x == null ? null : Number(x))

export async function tournamentRow(db, id, lock = '') {
  const {
    rows: [row],
  } = await db.query('SELECT * FROM tournaments WHERE id=$1 ' + lock, [id])
  if (!row) throw new ProductError(404, 'Tournament not found')
  return row
}
export async function entrants(db, id) {
  const { rows } = await db.query(
    `SELECT id,owner_id AS "ownerId",player_id AS "playerId",
    name,owner_name AS owner,engine_name AS "engineName",seed,state,qualified_seed AS "qualifiedSeed",
    last_seen AS "lastSeen",deck_id AS "deckId",deck_revision AS revision,deck_name AS "deckName"
    FROM tournament_entries WHERE tournament_id=$1 ORDER BY seed,id`,
    [id],
  )
  return rows.map((p) => ({ ...p, lastSeen: timestamp(p.lastSeen) }))
}
export async function pairings(db, id) {
  const { rows } = await db.query(
    `SELECT id,round_number AS "roundNumber",stage,number,best_of AS "bestOf",
    entry_a AS a,entry_b AS b,winner_entry AS winner,table_id AS "tableId",match_id AS "matchId",deadline_at AS "deadlineAt",
    ack_a AS "ackA",ack_b AS "ackB",attendance_elapsed_ms AS "attendanceElapsed",attendance_observed_at AS "attendanceObserved",
    wins_a AS "winsA",wins_b AS "winsB",draws,
    completed,launched,result_reason AS reason FROM tournament_pairings WHERE tournament_id=$1 ORDER BY round_number,number`,
    [id],
  )
  return rows.map((row) => ({
    ...row,
    deadlineAt: timestamp(row.deadlineAt),
    attendanceElapsed: Number(row.attendanceElapsed),
    attendanceObserved: timestamp(row.attendanceObserved),
  }))
}

export function summary(t) {
  return {
    id: t.id,
    name: t.name,
    format: t.format,
    template: t.template,
    cut: t.cut,
    capacity: t.capacity,
    swissBestOf: t.swiss_best_of,
    playoffBestOf: t.playoff_best_of,
    maxAgentsPerOwner: t.max_agents_per_owner,
    coaching: t.coaching,
    breakMinutes: t.break_minutes,
    stage: t.stage,
    status: t.status,
    roundNumber: t.round_number,
    roundsTotal: t.rounds_total,
    cutSize: t.cut_size,
    championId: t.champion_id,
    deadlineAt: timestamp(t.deadline_at),
    nextRoundAt: timestamp(t.next_round_at),
    nextSessionAt: timestamp(t.next_session_at),
  }
}

export async function view(db, t, actor, now, onlineMs) {
  const players = await entrants(db, t.id),
    matches = await pairings(db, t.id)
  const ranked = rankStandings(players, matches)
  // Playoff finish is ordered by the last stage reached, then Swiss seeding.
  if (t.stage === 'playoffs') {
    const reached = new Map()
    for (const m of matches.filter((m) => m.stage === 'playoffs')) {
      reached.set(m.a, m.roundNumber)
      if (m.b) reached.set(m.b, m.roundNumber)
    }
    ranked.sort(
      (a, b) =>
        Number(b.id === t.champion_id) - Number(a.id === t.champion_id) ||
        (reached.get(b.id) ?? 0) - (reached.get(a.id) ?? 0) ||
        (a.qualifiedSeed ?? Infinity) - (b.qualifiedSeed ?? Infinity) ||
        a.rank - b.rank,
    )
  }
  const standings = ranked.map((p, i) => ({
    id: p.id,
    playerId: p.playerId,
    name: p.name,
    owner: p.owner,
    kind: p.playerId ? 'agent' : 'human',
    state: p.state,
    rank: i + 1,
    points: p.points,
    wins: p.wins,
    losses: p.losses,
    ties: p.ties,
    omw: p.omw,
    gw: p.gw,
    ogw: p.ogw,
    online: p.lastSeen != null && now - p.lastSeen <= onlineMs,
  }))
  const { rows: publishedIds } = await db.query(
    `SELECT p.entry_id FROM published_tournament_entries p JOIN tournament_entries e ON e.id=p.entry_id
    WHERE e.tournament_id=$1`,
    [t.id],
  )
  const publishedSet = new Set(publishedIds.map((p) => p.entry_id))
  const published = players.filter((p) => publishedSet.has(p.id))
  const deckLists = await registeredDecklists(db, published.map(p => p.id))
  return {
    ...summary(t),
    viewer: {
      isAdmin: actor?.isAdmin === true && !actor.agent,
      accountName: actor?.username ?? null,
      entryIds: players
        .filter((p) => p.ownerId === actor?.accountId && (!actor.agent || p.playerId === actor.playerId))
        .map((p) => p.id),
    },
    registeredCount: players.length,
    participants: standings,
    standings,
    deckLists,
    pairings: matches.map(({ ackA, ackB, attendanceObserved, attendanceElapsed, ...m }) => {
      const observed = attendanceObserved !== null && now - attendanceObserved <= attendanceSampleWindowMs
      const attendanceClock = observed && m.tableId && !m.completed && !m.launched && (!ackA || !ackB)
      return {
        ...m,
        attendanceDeadlineAt: attendanceClock ? attendanceObserved + 10 * minute - attendanceElapsed : null,
        absentWarningIds:
          attendanceClock && attendanceElapsed >= 3 * minute
            ? [!ackA ? m.a : null, !ackB ? m.b : null].filter(Boolean)
            : [],
      }
    }),
  }
}

// Both this transition and result recording run under the tournament row lock.
export async function startRound(db, t, now) {
  const players = await entrants(db, t.id),
    history = await pairings(db, t.id)
  const ranked = rankStandings(players, history)
  let stage = 'swiss',
    pairs
  const active = ranked.filter((p) => p.state === 'active')
  const lockedCut = t.cut_size > 0 && ranked.filter((p) => p.state === 'qualified').length >= t.cut_size
  if (t.stage !== 'playoffs' && t.round_number < t.rounds_total && active.length && !lockedCut) {
    pairs = swissPairings(active, history)
  } else {
    if (!t.cut_size) return finish(db, t.id, active[0]?.id ?? null)
    stage = 'playoffs'
    if (t.stage === 'playoffs') {
      const last = history.filter((m) => m.roundNumber === t.round_number)
      const winners = last.map((m) => m.winner)
      const remaining = new Set(players.filter((p) => p.state === 'active').map((p) => p.id))
      pairs = []
      for (let i = 0; i < winners.length; i += 2) {
        const a = remaining.has(winners[i]) ? winners[i] : null
        const b = remaining.has(winners[i + 1]) ? winners[i + 1] : null
        if (a || b) pairs.push(a ? [a, b] : [b, null])
      }
    } else {
      const pool = ranked.filter((p) => ['active', 'qualified'].includes(p.state))
      pool.sort((a, b) => (a.qualifiedSeed ?? Infinity) - (b.qualifiedSeed ?? Infinity) || a.rank - b.rank)
      const cut = pool.slice(0, t.cut_size)
      for (const [i, p] of cut.entries())
        await db.query("UPDATE tournament_entries SET state='active',qualified_seed=$2 WHERE id=$1", [p.id, i + 1])
      await db.query(
        "UPDATE tournament_entries SET state='eliminated' WHERE tournament_id=$1 AND state='active' AND qualified_seed IS NULL",
        [t.id],
      )
      pairs = eliminationPairs(
        cut.map((p) => p.id),
        t.cut_size,
      )
    }
  }
  if (pairs.length === 0)
    return finish(db, t.id, ranked.find((p) => p.state === 'qualified' || p.state === 'active')?.id ?? null)
  const number = t.round_number + 1
  const bestOf = stage === 'swiss' ? t.swiss_best_of : t.playoff_best_of
  const deadline = stage === 'playoffs' && t.template === 'worlds' ? null : now + roundDurationMs
  await db.query(
    `UPDATE tournaments SET status='playing',stage=$2,round_number=$3,deadline_at=$4,next_round_at=NULL,next_session_at=NULL WHERE id=$1`,
    [t.id, stage, number, deadline],
  )
  for (const [index, [a, b]] of pairs.entries()) {
    const bye = b == null
    await db.query(
      `INSERT INTO tournament_pairings(tournament_id,round_number,stage,number,best_of,entry_a,entry_b,
      opened_at,deadline_at,completed,wins_a,result_reason,winner_entry) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        t.id,
        number,
        stage,
        index + 1,
        bestOf,
        a,
        b,
        now,
        deadline,
        bye,
        bye ? Math.ceil(bestOf / 2) : 0,
        bye ? 'bye' : null,
        bye ? a : null,
      ],
    )
  }
  if (pairs.every(([, b]) => !b)) await advanceIfComplete(db, await tournamentRow(db, t.id), now)
}

async function finish(db, id, winner) {
  await db.query(
    "UPDATE tournaments SET status='finished',champion_id=$2,deadline_at=NULL,next_round_at=NULL,next_session_at=NULL WHERE id=$1",
    [id, winner],
  )
}

export async function advanceIfComplete(db, t, now) {
  if (t.status !== 'playing') return
  // The last result closes the round. Other tables do not need to load the tournament history.
  const pending = await db.query(
    'SELECT 1 FROM tournament_pairings WHERE tournament_id=$1 AND round_number=$2 AND NOT completed LIMIT 1',
    [t.id, t.round_number],
  )
  if (pending.rowCount) return
  const history = await pairings(db, t.id)
  const latest = history.filter((m) => m.roundNumber === t.round_number)
  if (!latest.length) return
  const players = await entrants(db, t.id)
  const ranked = rankStandings(players, history)
  if (t.stage === 'playoffs') {
    const lost = latest.filter((m) => m.b).flatMap((m) => [m.a, m.b].filter((id) => id !== m.winner))
    await db.query("UPDATE tournament_entries SET state='eliminated' WHERE id=ANY($1::uuid[]) AND state='active'", [
      lost,
    ])
    if (latest.length === 1) {
      const winner = latest[0].winner
      return finish(db, t.id, players.find((p) => p.id === winner)?.state === 'disqualified' ? null : winner)
    }
  } else {
    if (t.template === 'worlds') {
      if (t.round_number === 7) {
        const eliminated = ranked.filter((p) => p.state === 'active' && p.points < 12).map((p) => p.id)
        await db.query("UPDATE tournament_entries SET state='eliminated' WHERE id=ANY($1::uuid[])", [eliminated])
      }
      if (t.round_number < 14) {
        let seed = ranked.filter((p) => p.qualifiedSeed != null).length
        for (const p of ranked
          .filter((p) => p.wins >= 10 && p.state === 'active')
          .sort((a, b) => b.omw - a.omw || b.gw - a.gw || b.ogw - a.ogw || a.seed - b.seed)) {
          if (seed >= 8) break
          await db.query("UPDATE tournament_entries SET state='qualified',qualified_seed=$2 WHERE id=$1", [
            p.id,
            ++seed,
          ])
        }
      }
    }
    if (t.round_number === t.rounds_total && !t.cut_size)
      return finish(db, t.id, ranked.find((p) => p.state === 'active')?.id ?? null)
  }
  const overnight = t.template === 'worlds' && t.stage === 'swiss' && [7, 14].includes(t.round_number)
  await db.query('UPDATE tournaments SET status=$2,next_round_at=$3,deadline_at=NULL WHERE id=$1', [
    t.id,
    overnight ? 'paused' : 'break',
    overnight ? null : now + t.break_minutes * minute,
  ])
}
