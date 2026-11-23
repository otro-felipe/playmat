import blossom from 'edmonds-blossom'

/** Appendix E for a Constructed event; rounds-only events keep everyone playing. */
export function tournamentStructure({ template, cut, swissRounds }, count) {
  if (template === 'worlds') return { swissRounds: 14, cutSize: 8 }
  if (cut === 'none') return { swissRounds: swissRounds ?? Math.ceil(Math.log2(count)), cutSize: 0 }
  if (count <= 8) return { swissRounds: 0, cutSize: 2 ** Math.ceil(Math.log2(count)) }
  const limits = [32, 64, 128, 226, 409]
  const index = limits.findIndex((limit) => count <= limit)
  return { swissRounds: index < 0 ? 10 : index + 5, cutSize: count <= 16 ? 4 : 8 }
}

const rate = (points, possible) => Math.max(0.33, possible ? points / possible : 0)
const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0)

/** Only completed Swiss matches contribute. A bye adds a match and games, but never an opponent. */
export function rankStandings(players, history) {
  const standings = new Map(
    players.map((player) => [
      player.id,
      {
        ...player,
        points: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        gamePoints: 0,
        games: 0,
        opponents: [],
        byes: 0,
      },
    ]),
  )
  function award(id, opponent, won, lost, drawn, winner) {
    const p = standings.get(id)
    if (!p) return
    if (winner === id) {
      p.wins++
      p.points += 3
    } else if (winner == null) {
      p.ties++
      p.points++
    } else p.losses++
    p.games += won + lost + drawn
    p.gamePoints += won * 3 + drawn
    if (opponent) p.opponents.push(opponent)
    else p.byes++
  }
  for (const match of history) {
    if (!match.completed || match.stage !== 'swiss') continue
    if (match.reason === 'double_forfeit') {
      for (const [id, opponent] of [
        [match.a, match.b],
        [match.b, match.a],
      ]) {
        const p = standings.get(id)
        if (p) {
          p.losses++
          p.opponents.push(opponent)
        }
      }
      continue
    }
    const winner = match.winner ?? (match.winsA > match.winsB ? match.a : match.winsB > match.winsA ? match.b : null)
    award(match.a, match.b, match.winsA, match.winsB, match.draws, winner)
    if (match.b) award(match.b, match.a, match.winsB, match.winsA, match.draws, winner)
  }
  for (const p of standings.values()) {
    p.mw = rate(p.points, 3 * (p.wins + p.losses + p.ties))
    p.gw = rate(p.gamePoints, 3 * p.games)
  }
  for (const p of standings.values()) {
    p.omw = mean(p.opponents.map((id) => standings.get(id).mw))
    p.ogw = mean(p.opponents.map((id) => standings.get(id).gw))
  }
  return [...standings.values()]
    .sort((a, b) => b.points - a.points || b.omw - a.omw || b.gw - a.gw || b.ogw - a.ogw || a.seed - b.seed)
    .map((p, index) => ({ ...p, rank: index + 1 }))
}

export function swissPairings(standings, history) {
  const seats = [...standings]
  const results = []
  if (seats.length % 2) {
    const bye = [...seats].reverse().sort((a, b) => a.byes - b.byes || a.points - b.points)[0]
    seats.splice(seats.indexOf(bye), 1)
    results.push([bye.id, null])
  }
  if (!seats.length) return results
  const pairs = new Map()
  const key = (a, b) => [a, b].sort().join(':')
  for (const h of history.filter((h) => h.stage === 'swiss' && h.b)) {
    const k = key(h.a, h.b)
    pairs.set(k, 1 + (pairs.get(k) ?? 0))
  }
  // Minimize total rematches, then total point difference, then shared owners.
  const edgeCount = seats.length / 2
  const scoreUnit = edgeCount + 1
  const rematchUnit = scoreUnit * (1 + edgeCount * Math.max(...seats.map((p) => p.points)))
  const costs = []
  let max = 0
  for (let i = 0; i < seats.length; i++)
    for (let j = i + 1; j < seats.length; j++) {
      const a = seats[i],
        b = seats[j]
      const cost =
        (pairs.get(key(a.id, b.id)) ?? 0) * rematchUnit +
        Math.abs(a.points - b.points) * scoreUnit +
        Number(a.ownerId === b.ownerId)
      max = Math.max(max, cost)
      costs.push([i, j, cost])
    }
  const mate = blossom(
    costs.map(([a, b, c]) => [a, b, max + 1 - c]),
    true,
  )
  for (let i = 0; i < mate.length; i++) if (i < mate[i]) results.push([seats[i].id, seats[mate[i]].id])
  return results
}

export function eliminationPairs(ordered, bracketSize = 2 ** Math.ceil(Math.log2(ordered.length))) {
  let seeds = [1, 2]
  while (seeds.length < bracketSize) seeds = seeds.flatMap((seed) => [seed, seeds.length * 2 + 1 - seed])
  const pairs = []
  for (let i = 0; i < seeds.length; i += 2) {
    const a = ordered[seeds[i] - 1] ?? null,
      b = ordered[seeds[i + 1] - 1] ?? null
    if (a || b) pairs.push(a ? [a, b] : [b, a])
  }
  return pairs
}
