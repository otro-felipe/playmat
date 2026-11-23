import { attendanceStructureRanges } from './tournament-preview.mjs'
import { isUuid, ProductError } from './decks.mjs'
import { ownedPlayer } from './tournament-access.mjs'
import { clientKey, createConcurrencyLimit, createLimits } from './limits.mjs'

const base = '/api/playtesting/tournaments'
const page = '/tournaments/'
const missing = () => new ProductError(404, 'Tournament operation not found')
const viewer = (actor) => (actor ? { username: actor.username, isAdmin: actor.isAdmin === true } : null)

export function createTournamentRoutes({
  pool,
  tournaments,
  bridge,
  broadcast,
  resolveActor,
  body,
  send,
  requireScope,
}) {
  const streams = new Set()
  const limitHeartbeat = createLimits({ seat: { client: 90, total: 32_000, window: 60_000 } })
  const acquireStream = createConcurrencyLimit(200, 12)
  let timer, running
  async function inputObject(req) {
    const data = await body(req, 'optional-json', 4096)
    if (!data || Array.isArray(data) || typeof data !== 'object')
      throw new ProductError(400, 'Provide tournament settings as an object')
    return data
  }

  async function snapshot(id, actor) {
    const detail = await tournaments.get(id, actor)
    const human = actor && !actor.agent && detail.participants.find(
      (entry) => entry.kind === 'human' && detail.viewer.entryIds.includes(entry.id),
    )
    const seat = human && detail.pairings.find((p) => !p.completed && p.tableId && [p.a, p.b].includes(human.id))
    const { rows: [game] } = seat
      ? await pool.query(
          `SELECT g.id FROM games g JOIN matches m ON m.id=g.match_id
           WHERE g.status='active' AND m.table_id IN (SELECT table_id FROM tournament_pairing_tables WHERE pairing_id=$1)
           ORDER BY g.game_number DESC LIMIT 1`,
          [seat.id],
        )
      : { rows: [] }
    detail.pairings = detail.pairings.map((p) => {
      if (!p.tableId) return p
      const href = page + id + '/pairings/' + p.id
      return {
        ...p,
        ...(!p.completed && { watchUrl: href + '/watch' }),
        ...((p.completed || actor?.isAdmin) && { replayUrl: href + '/replay' }),
        ...(p.id === seat?.id && { playUrl: game ? '/game/' + game.id : '/' }),
      }
    })
    detail.viewer = actor ? { ...detail.viewer, ...viewer(actor) } : null
    return detail
  }

  async function stream(req, res, read) {
    const release = acquireStream(clientKey(req))
    if (!release) throw new ProductError(429, 'Too many tournament streams')
    let interval,
      busy = false,
      last,
      lastSent = Date.now()
    const close = () => {
      clearInterval(interval)
      streams.delete(res)
      release()
    }
    streams.add(res)
    res.once('close', close)
    const write = async () => {
      const next = JSON.stringify(await read())
      if (res.destroyed) return
      if (next !== last || Date.now() - lastSent > 15000) {
        if (
          !res.write(next === last ? ': heartbeat\n\n' : 'event: snapshot\ndata: ' + next + '\n\n') &&
          res.writableLength > 2 * 1024 * 1024
        )
          res.destroy()
        last = next
        lastSent = Date.now()
      }
    }
    // Validate access before switching protocols.
    const first = JSON.stringify(await read())
    if (res.destroyed) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    })
    res.write('event: snapshot\ndata: ' + first + '\n\n')
    last = first
    interval = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        await write()
      } catch {
        res.end()
      } finally {
        busy = false
      }
    }, 2000)
    interval.unref()
  }

  async function route(req, res, url) {
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false
    const segments = url.pathname.slice(base.length).split('/').filter(Boolean)
    const [id, operation, pairId, kind, tail] = segments
    const actor = await resolveActor(req)
    const read = req.method === 'GET'
    if (!read && !actor) throw new ProductError(401, 'Sign in to register or manage a tournament')
    if (!read && req.method !== 'POST') throw new ProductError(405, 'Use POST')
    if (!read) requireScope(actor, 'play')
    if (!id) {
      if (read)
        send(res, 200, {
          tournaments: await tournaments.list(actor),
          viewer: viewer(actor),
          mayCreate: actor?.isAdmin === true,
          ...(actor?.isAdmin && { attendanceStructures: attendanceStructureRanges }),
        })
      else send(res, 201, await tournaments.create(actor, await inputObject(req)))
    } else if (id === 'profile' && segments.length === 2 && read && /^[a-z0-9_-]{3,24}$/i.test(operation)) {
      send(res, 200, await tournaments.profile(operation))
    } else if (id === 'table' && segments.length === 2 && isUuid(operation) && read && actor) {
      const {
        rows: [table],
      } = await pool.query(
        `SELECT tournament_id AS "tournamentId",round_number AS "roundNumber",
        deadline_at::float8 AS "deadlineAt",stage FROM tournament_pairings p
        WHERE p.id=tournament_pairing_for_table($1) OR EXISTS
        (SELECT FROM matches m JOIN games g ON g.match_id=m.id WHERE g.id=$1
        AND (m.id=p.match_id OR p.id=tournament_pairing_for_table(m.table_id)))`,
        [operation],
      )
      send(res, 200, table ?? null)
    } else if (!isUuid(id)) throw missing()
    else if (read && segments.length === 1) send(res, 200, await snapshot(id, actor))
    else if (read && operation === 'events' && segments.length === 2)
      await stream(req, res, async () => snapshot(id, await resolveActor(req)))
    else if (
      read &&
      operation === 'pairings' &&
      isUuid(pairId) &&
      (segments.length === 4 || (segments.length === 5 && tail === 'events'))
    ) {
      if (kind === 'watch') {
        const hands = url.searchParams.get('hands') === '1'
        if (tail)
          await stream(req, res, async () => broadcast.live(id, pairId, await resolveActor(req), hands))
        else send(res, 200, await broadcast.live(id, pairId, actor, hands))
      } else if (kind === 'replay' && !tail)
        send(res, 200, await broadcast.replay(id, pairId, actor, url.searchParams))
      else throw missing()
    } else if (!read && segments.length === 2) {
      const input = await inputObject(req)
      if (operation === 'join') {
        let seat = actor
        if (input.playerId && input.playerId !== actor.playerId) {
          const player = await ownedPlayer(pool, actor, input.playerId, true)
          seat = {
            ...actor,
            agent: true,
            isAdmin: false,
            playerId: player.id,
            engineName: player.engine_name,
            displayName: player.display_name,
          }
        }
        send(res, 200, await tournaments.join(id, seat, input))
      } else if (operation === 'admin') send(res, 200, await tournaments.action(id, actor, input))
      else if (operation === 'wait') {
        const retry = limitHeartbeat('seat', actor.playerId ?? actor.accountId)
        if (retry) {
          res.setHeader('Retry-After', String(retry))
          throw new ProductError(429, 'Tournament check-ins are too frequent')
        }
        const receipt = await tournaments.wait(id, actor)
        send(res, 200, await bridge.connectSeat(actor, receipt, input.readyTableId, id))
      } else throw missing()
    } else throw missing()
    return true
  }

  async function tick() {
    if (running) return running
    running = (async () => {
      await tournaments.tick()
      await bridge.tick()
    })()
      .catch(() => console.warn('Tournament round update delayed'))
      .finally(() => {
        running = null
      })
    return running
  }
  return {
    route,
    start() {
      if (!timer) {
        void tick()
        timer = setInterval(tick, 2000)
        timer.unref()
      }
    },
    async stop() {
      clearInterval(timer)
      for (const res of streams) res.end()
      await running
    },
  }
}
