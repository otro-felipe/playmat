import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createArchive } from './archive.mjs'
import { createIdentity, identityView } from './identity.mjs'
import { ProductError, deleteDeck, getDeck, isUuid, listDecks, normalize, normalizeFormat, putDeck } from './decks.mjs'

const maxBody = 300 * 1024
const directory = dirname(fileURLToPath(import.meta.url))

function send(res, status, data) {
  if (Buffer.isBuffer(data)) {
    res.writeHead(status, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="playmat-replays.zip"' })
    res.end(data)
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function requireScope(actor, capability) {
  if (!actor.scopes.includes(capability)) throw new ProductError(403, 'This credential cannot use that capability')
}

function safeNext(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u0020]/.test(value)) return '/'
  const target = new URL(value, 'https://playmat.local')
  if (target.origin !== 'https://playmat.local' || target.pathname === '/login' || target.pathname === '/logout') return '/'
  return target.pathname + target.search + target.hash
}

function escapeHtml(value) {
  return String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char])
}

function loginPage(res, next, wrong = false) {
  res.writeHead(wrong ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html lang="es"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Playmat · Entrar</title>
    <style>
    :root{color-scheme:dark;font:16px system-ui;background:#171c18;color:#f5f3ed}
    body{margin:0;min-height:100dvh;display:grid;place-items:center}
    main{box-sizing:border-box;width:min(92vw,25rem);padding:2rem;background:#222b24;border:1px solid #405043;border-radius:1rem}
    h1{margin-top:0}form,label{display:grid;gap:.65rem}form{gap:1rem}
    input,button{border:1px solid #687568;border-radius:.5rem;padding:.8rem;color:inherit;font:inherit;background:#18201a}
    button{cursor:pointer;background:#c6dfaf;color:#182018;font-weight:650}p{color:#ffc4a8}
    </style></head><body><main><h1>Playmat</h1>
    ${wrong ? '<p role="alert">Revisa tu usuario y contraseña.</p>' : ''}
    <form action="/login" method="post"><input type="hidden" name="next" value="${escapeHtml(next)}">
    <label>Usuario<input name="username" autocomplete="username" maxlength="24" required autofocus></label>
    <label>Contraseña<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
    <button type="submit">Entrar</button></form></main></body></html>`)
}

function sameOrigin(req, insecureCookie) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.host.toLowerCase() === req.headers.host?.toLowerCase()
      && (parsed.protocol === 'https:' || (insecureCookie && parsed.protocol === 'http:'))
  } catch {
    return false
  }
}

async function body(req, parse = 'json', limit = maxBody) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw new ProductError(413, 'Request is too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (parse === 'form') return new URLSearchParams(raw)
  try {
    return JSON.parse(raw)
  } catch {
    throw new ProductError(400, 'Request body must be JSON')
  }
}

function rejectMissing(value, message) {
  if (!value) throw new ProductError(404, message)
  return value
}

function invitationView(row) {
  return { tableId: row.table_id, roomId: row.room_id, format: row.format, guestEngineName: row.invitee_name, expiresAt: row.expires_at }
}

export async function createProduct({
  databaseUrl, schema = 'playmat_product', replayDirectory, store, insecureCookie = false, enableInternal = true,
}) {
  if (!databaseUrl || !/^[a-z_][a-z0-9_]{0,60}$/.test(schema)) throw Error('A valid product database configuration is required')
  const pool = new pg.Pool({
    connectionString: databaseUrl, options: '-c search_path=' + schema, max: 10, connectionTimeoutMillis: 5000,
  })
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
    await pool.query(await readFile(resolve(directory, 'schema.sql'), 'utf8'))
  } catch (error) {
    await pool.end()
    throw error
  }
  const id = createIdentity(pool, insecureCookie)
  const archive = createArchive(pool, replayDirectory, store)
  const attempts = new Map()

  function throttle(key) {
    const now = Date.now()
    if (attempts.size > 1000) for (const [k, count] of attempts) if (count.expiresAt <= now) attempts.delete(k)
    if (attempts.size > 2000 && !attempts.has(key)) throw new ProductError(429, 'Too many sign-in attempts')
    const entry = attempts.get(key)
    const count = entry?.expiresAt > now ? entry : { attempts: 0, expiresAt: now + 60_000 }
    if (++count.attempts > 12) throw new ProductError(429, 'Too many sign-in attempts')
    attempts.set(key, count)
  }

  async function listInvites(actor, requestedLimit) {
    const limit = Math.max(1, Math.min(50, Number.parseInt(requestedLimit, 10) || 25))
    const { rows } = await pool.query(
      'SELECT * FROM invitations WHERE invitee_key=$1 AND expires_at>now() ORDER BY expires_at DESC,table_id LIMIT $2',
      [normalize(actor.engineName), limit],
    )
    return { invites: rows.map(invitationView) }
  }

  async function createInvite(actor, data) {
    const format = normalizeFormat(data.format)
    if (!isUuid(data.tableId) || !isUuid(data.roomId) || !format || typeof data.password !== 'string'
      || data.password.length < 12 || data.password.length > 100) throw new ProductError(400, 'Provide a valid protected table')
    const invitee = await id.fromEngine(data.guestEngineName)
    if (!invitee || normalize(invitee.engineName) === normalize(actor.engineName) || !invitee.scopes.includes('play')) {
      throw new ProductError(400, 'Provide a provisioned guest seat')
    }
    const { rows: [invite] } = await pool.query(`INSERT INTO invitations(table_id,room_id,format,creator_key,invitee_key,invitee_name,table_password,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours') ON CONFLICT (table_id) DO NOTHING RETURNING *`,
    [data.tableId, data.roomId, format, normalize(actor.engineName), normalize(invitee.engineName), invitee.engineName, data.password])
    if (!invite) throw new ProductError(409, 'This table already has an invitation')
    return invitationView(invite)
  }

  async function claimInvite(actor, tableId) {
    if (!isUuid(tableId)) throw new ProductError(404, 'Invitation not found')
    const { rows: [invite] } = await pool.query(`UPDATE invitations SET claimed_at=COALESCE(claimed_at,now())
      WHERE table_id=$1 AND invitee_key=$2 AND expires_at>now() RETURNING *`, [tableId, normalize(actor.engineName)])
    return { ...invitationView(rejectMissing(invite, 'Invitation not found')), password: invite.table_password }
  }

  async function legacy(req, res) {
    const actor = await id.fromEngine(req.headers['x-playmat-engine-user'])
    if (!actor) throw new ProductError(401, 'Authentication required')
    const params = await body(req)
    switch (params.method) {
      case 'replayList': {
        requireScope(actor, 'history')
        const { matches } = await archive.matchList(actor, { limit: 100 })
        return send(res, 200, matches.flatMap(match => match.games.filter(game => game.replayAvailable)))
      }
      case 'replayPage': {
        requireScope(actor, 'history')
        try {
          return send(res, 200, await archive.replayPage(actor, params.gameId, params.start, params.count))
        } catch (error) {
          if (error.status === 404) return send(res, 200, null)
          throw error
        }
      }
      default: throw new ProductError(404, 'Operation not found')
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    void route(req, res).catch(error => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const status = Number.isInteger(error?.status) ? error.status : 500
      if (status >= 500) console.warn('Playmat product request failed', { status, code: typeof error?.code === 'string' ? error.code : undefined })
      send(res, status, { error: status === 500 ? 'Product service unavailable' : error.message })
    })
  })

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (path === '/healthz' && req.method === 'GET') {
      await pool.query('SELECT 1')
      return send(res, 200, { status: 'ok' })
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req, insecureCookie)) throw new ProductError(403, 'Cross-origin request')
    if (path === '/login' && req.method === 'GET') {
      const next = safeNext(url.searchParams.get('next'))
      if (await id.resolve(req)) return res.writeHead(303, { Location: next }).end()
      return loginPage(res, next)
    }
    if (path === '/login' && req.method === 'POST') {
      const form = await body(req, 'form', 4096)
      const next = safeNext(form.get('next'))
      const username = form.get('username')
      throttle(normalize(username).slice(0, 24))
      const cookie = await id.signIn(username, form.get('password'))
      if (cookie) return res.writeHead(303, { 'Set-Cookie': cookie, Location: next }).end()
      return loginPage(res, next, true)
    }
    if (path === '/logout' && req.method === 'POST') {
      return res.writeHead(303, { 'Set-Cookie': await id.signOut(req), Location: '/login' }).end()
    }
    if (enableInternal && path === '/internal/legacy' && req.method === 'POST') return legacy(req, res)
    if (enableInternal && path === '/internal/invites' && req.method === 'GET') {
      const result = await pool.query('SELECT table_id FROM invitations WHERE invitee_key=$1 AND expires_at>now()', [
        normalize(url.searchParams.get('guest')),
      ])
      return send(res, 200, result.rows.map(row => row.table_id))
    }
    if (enableInternal && path.startsWith('/internal/invites/') && req.method === 'GET') {
      const tableId = path.slice('/internal/invites/'.length)
      if (!isUuid(tableId)) throw new ProductError(404, 'Invitation not found')
      const { rowCount } = await pool.query('SELECT 1 FROM invitations WHERE table_id=$1 AND creator_key=$2 AND invitee_key=$3 AND claimed_at IS NOT NULL AND expires_at>now()', [
        tableId, normalize(url.searchParams.get('host')), normalize(url.searchParams.get('guest')),
      ])
      return send(res, rowCount ? 200 : 404, { allowed: Boolean(rowCount) })
    }
    if (!path.startsWith('/api/playtesting/') && !(enableInternal && path === '/internal/verify')) throw new ProductError(404, 'Not found')
    const actor = await id.resolve(req)
    if (!actor) {
      if (path === '/internal/verify' && url.searchParams.get('redirect') === '1') {
        const next = safeNext(req.headers['x-forwarded-uri'])
        return res.writeHead(303, { Location: '/login?next=' + encodeURIComponent(next) }).end()
      }
      throw new ProductError(401, 'Authentication required')
    }
    if (enableInternal && path === '/internal/verify' && req.method === 'GET') {
      if (url.searchParams.get('scope') === 'play') requireScope(actor, 'play')
      res.setHeader('X-Playmat-User', actor.engineName)
      res.setHeader('X-Playmat-Account', actor.accountId)
      return send(res, 200, identityView(actor))
    }
    const endpoint = path.slice('/api/playtesting/'.length)
    if (endpoint === 'me' && req.method === 'GET') return send(res, 200, identityView(actor))
    if (endpoint === 'decks' || endpoint.startsWith('decks/')) {
      const expectedOwner = req.headers['x-playmat-deck-owner']
      if (expectedOwner && normalize(expectedOwner) !== normalize(actor.username)) throw new ProductError(403, 'The browser session has changed')
    }
    if (endpoint === 'decks' && req.method === 'GET') {
      requireScope(actor, 'library')
      return send(res, 200, { decks: await listDecks(pool, actor.accountId, url.searchParams.get('deleted') === '1') })
    }
    if (endpoint.startsWith('decks/')) {
      requireScope(actor, 'library')
      let deckId
      try {
        deckId = decodeURIComponent(endpoint.slice('decks/'.length))
      } catch {
        throw new ProductError(400, 'Invalid deck ID')
      }
      if (req.method === 'GET') {
        const revision = url.searchParams.get('revision')
        if (revision && !/^\d{1,8}$/.test(revision)) throw new ProductError(400, 'Invalid revision')
        return send(res, 200, rejectMissing(await getDeck(pool, actor.accountId, deckId, revision), 'Deck not found'))
      }
      if (req.method === 'PUT') return send(res, 200, await putDeck(pool, actor.accountId, deckId, await body(req)))
      if (req.method === 'DELETE') {
        const data = await body(req)
        await deleteDeck(pool, actor.accountId, deckId, data.expectedRevision)
        return send(res, 200, { deleted: true })
      }
    }
    if (endpoint === 'invites') {
      requireScope(actor, 'play')
      if (req.method === 'GET') return send(res, 200, await listInvites(actor, url.searchParams.get('limit')))
      if (req.method === 'POST') return send(res, 201, await createInvite(actor, await body(req)))
    }
    if (req.method === 'POST' && /^invites\/[a-f0-9-]+\/claim$/i.test(endpoint)) {
      requireScope(actor, 'play')
      return send(res, 200, await claimInvite(actor, endpoint.split('/')[1]))
    }
    if (endpoint === 'matches' && req.method === 'GET') {
      requireScope(actor, 'history')
      return send(res, 200, await archive.matchList(actor, Object.fromEntries(url.searchParams)))
    }
    if (endpoint === 'stats' && req.method === 'GET') {
      requireScope(actor, 'history')
      return send(res, 200, await archive.statistics(actor, url.searchParams.get('format')))
    }
    if (endpoint.startsWith('matches/') && req.method === 'GET') {
      requireScope(actor, 'history')
      const id = endpoint.slice('matches/'.length)
      if (!isUuid(id)) throw new ProductError(404, 'Match not found')
      const { matches: [match] } = await archive.matchList(actor, { id, limit: 1 })
      return send(res, 200, rejectMissing(match, 'Match not found'))
    }
    if (endpoint.startsWith('replays/') && req.method === 'GET') {
      requireScope(actor, 'history')
      return send(res, 200, await archive.replayPage(actor, endpoint.slice('replays/'.length), url.searchParams.get('start'), url.searchParams.get('count')))
    }
    if (endpoint === 'exports' && req.method === 'POST') {
      requireScope(actor, 'history')
      const { gameIds, mode } = await body(req)
      if (mode === 'handle') {
        const games = await archive.authorizeExport(actor, gameIds)
        const exportId = randomUUID()
        await pool.query('DELETE FROM replay_exports WHERE expires_at <= now()')
        const { rows: [{ expires_at: expiresAt }] } = await pool.query(
          "INSERT INTO replay_exports(id,account_id,engine_key,game_ids,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 hour') RETURNING expires_at",
          [exportId, actor.accountId, normalize(actor.engineName), games.map(game => game.id)],
        )
        return send(res, 201, { exportId, expiresAt, path: '/api/playtesting/exports/' + exportId })
      }
      return send(res, 200, Buffer.from(await archive.exportReplays(actor, gameIds)))
    }
    if (endpoint.startsWith('exports/') && req.method === 'GET') {
      requireScope(actor, 'history')
      const exportId = endpoint.slice('exports/'.length)
      if (!isUuid(exportId)) throw new ProductError(404, 'Export not found')
      const { rows: [record] } = await pool.query(
        'SELECT game_ids FROM replay_exports WHERE id=$1 AND account_id=$2 AND engine_key=$3 AND expires_at>now()',
        [exportId, actor.accountId, normalize(actor.engineName)],
      )
      if (!record) throw new ProductError(404, 'Export not found')
      return send(res, 200, Buffer.from(await archive.exportReplays(actor, record.game_ids)))
    }
    throw new ProductError(404, 'Not found')
  }

  return {
    server, provisionHuman: id.provisionHuman, provisionAgent: id.provisionAgent, revokeAgent: id.revokeAgent,
    importProvisionBundle: id.importProvisionBundle,
    archiveGames: archive.archiveGames,
    async dropTestSchema() {
      if (!schema.startsWith('test_')) throw Error('Refusing to remove data outside an isolated test schema')
      await pool.query('DROP SCHEMA ' + schema + ' CASCADE')
    },
    close: () => pool.end(),
  }
}
