import { archetypeCoverage, backfillSeatArchetypes } from './archived-archetypes.mjs'
import { authStyles } from './auth-styles.mjs'
import { accountLimits, clientKey, createConcurrencyLimit, createLimits, productLimitGroup, productLimits } from './limits.mjs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { archetypesFor } from './deck-performance-identity.mjs'
import { libraryArchetypeCoverage, migrateDeckLists, refineMigratedDeckLists, refineTournamentArchetypes } from './deck-list-migration.mjs'
import { excludeAsParticipant } from './match-statistics.mjs'
import { listPlayers, createPlayer, createPlayerSlot, updatePlayer } from './players.mjs'
import { changeReservation, restorePlayerReservations } from './player-reservations.mjs'
import { createArchive } from './archive.mjs'
import { resetMatchHistory, setUnlimitedMatchHistory } from './history-retention.mjs'
import { createTheoryStore, evaluateTheoryTactics } from './theory-store.mjs'
import { createIdentity, identityView } from './identity.mjs'
import { restoreSpectatorLink } from './spectator-links.mjs'
import { createSpectators, spectatorStorage, spectatorRoute } from './spectators.mjs'
import { createSignup } from './signup.mjs'
import { createTurnstile, loginChallengeAction } from './turnstile.mjs'
import { authorizeHumanConnection, humanBrowserMayPlay, listHumanMatches, readHumanSeat, recordHumanSeat, restoreHumanSeat } from './human-seats.mjs'
import { createInvitations } from './invitations.mjs'
import { createMcpEvents } from './mcp-events.mjs'
import { createOAuth } from './oauth.mjs'
import { createReviewPermissions } from './review-permissions.mjs'
import { createPostMatchReview } from './review.mjs'
import { ProductError, deleteDeck, getDeck, isUuid, listDecks, moveDeckLibrary, normalize, putDeck, transaction } from './decks.mjs'

const maxBody = 300 * 1024
const directory = dirname(fileURLToPath(import.meta.url))

function send(res, status, data) {
  if (Buffer.isBuffer(data)) {
    res.writeHead(status, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="thoughtseize-replays.zip"' })
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
  if (target.origin !== 'https://playmat.local' || target.pathname.startsWith('//')
    || target.pathname === '/login' || target.pathname === '/logout') return '/'
  return target.pathname + target.search + target.hash
}

function escapeHtml(value) {
  return String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[char])
}

function loginPage(res, next, { siteKey, status = 200, error } = {}) {
  const joinTable = /^\/join\/([a-f0-9-]+)$/i.exec(next)
  const signupHref = '/register' + (joinTable && isUuid(joinTable[1]) ? '?next=' + encodeURIComponent(next) : '')
  const challenge = siteKey ? ' https://challenges.cloudflare.com' : ''
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${challenge ? `; script-src${challenge}; frame-src${challenge}` : ''}`,
  })
  res.end(`<!doctype html><html lang="es"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Thoughtseize · Entrar</title>
    ${siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
    <style>
    ${authStyles}
    body{margin:0;min-height:100dvh;display:grid;place-items:center}
    main{width:min(92vw,25rem)}
    h1{margin-top:0}form,label{display:grid;gap:.65rem}form{gap:1rem}
    </style></head><body><main><h1>Thoughtseize</h1>
    ${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
    <form action="/login" method="post"><input type="hidden" name="next" value="${escapeHtml(next)}">
    <label>Usuario<input name="username" autocomplete="username" maxlength="24" required autofocus></label>
    <label>Contraseña<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
    ${siteKey ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${loginChallengeAction}" data-theme="dark" data-size="compact" data-appearance="interaction-only"></div>
    <noscript><p>Activa JavaScript para completar la verificación.</p></noscript>` : ''}
    <button type="submit">Entrar</button></form><p><a href="${signupHref}">Crear cuenta</a></p></main></body></html>`)
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
  if (parse === 'optional-json' && !raw) return {}
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

export async function createProduct({
  databaseUrl, schema = 'playmat_product', replayDirectory, store, insecureCookie = false, enableInternal = true,
  purgeExpiredHistory = false,
  publicUrl, oauthClients = [], oauthClientOptions, eventOptions, signup, turnstile, readSpectatorEngine,
}) {
  if (!databaseUrl || !/^[a-z_][a-z0-9_]{0,60}$/.test(schema)) throw Error('A valid product database configuration is required')
  const challenge = createTurnstile(publicUrl, turnstile)
  const pool = new pg.Pool({
    connectionString: databaseUrl, options: '-c search_path=' + schema, max: 10, connectionTimeoutMillis: 5000,
  })
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
    await pool.query(await readFile(resolve(directory, 'schema.sql'), 'utf8'))
    await pool.query(await readFile(resolve(directory, 'oauth-schema.sql'), 'utf8'))
    await pool.query(await readFile(resolve(directory, 'player-identities.sql'), 'utf8'))
    await pool.query(await readFile(resolve(directory, 'review-schema.sql'), 'utf8'))
    await pool.query(await readFile(resolve(directory, 'review-permissions.sql'), 'utf8'))
    await pool.query(await readFile(resolve(directory, 'theory-schema.sql'), 'utf8'))
    await pool.query(await readFile(resolve(directory, 'history-retention.sql'), 'utf8'))
    await migrateDeckLists(pool)
    await refineMigratedDeckLists(pool)
    await pool.query(await readFile(resolve(directory, 'performance-schema.sql'), 'utf8'))
    await transaction(pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('tournament-archetypes'))")
      const before = await archetypeCoverage(db)
      await refineTournamentArchetypes(db)
      await backfillSeatArchetypes(db)
      console.info('archetype_backfill', JSON.stringify({ before, after: await archetypeCoverage(db) }))
    })
    console.info('deck_archetype_coverage', JSON.stringify(await libraryArchetypeCoverage(pool)))
  } catch (error) {
    await pool.end()
    throw error
  }
  const oauth = createOAuth(pool, publicUrl, { body, clients: oauthClients, clientOptions: oauthClientOptions })
  const permissions = createReviewPermissions(pool)
  const id = createIdentity(pool, insecureCookie, oauth.resolve)
  const registration = createSignup(pool, id, publicUrl, signup, challenge)
  const archive = createArchive(pool, replayDirectory, store, { purgeExpiredHistory })
  const spectators = createSpectators({storage:spectatorStorage(pool, archive),readEngine:readSpectatorEngine})
  const review = createPostMatchReview(pool, archive, permissions)
  const theory = createTheoryStore(pool, review)
  const events = createMcpEvents(pool, eventOptions)
  const invitations = createInvitations(pool, id, events)
  const checkSource = createLimits(productLimits)
  const checkAccount = createLimits(accountLimits)
  const heavyWork = createConcurrencyLimit(12, 3)
  const archiveExports = createConcurrencyLimit(4, 1)
  const attempts = new Map()

  function throttleRequest(res, seconds) {
    if (!seconds) return
    res.setHeader('Retry-After', String(seconds))
    throw new ProductError(429, 'Too many requests. Try again shortly.')
  }

  function gateAccount(res, group, actor, releases) {
    throttleRequest(res, checkAccount(group, actor.accountId))
    if (!['archive', 'export', 'theory'].includes(group)) return
    const release = (group === 'export' ? archiveExports : heavyWork)(actor.accountId)
    if (!release) throttleRequest(res, 2)
    releases.push(release)
  }

  function throttle(key) {
    const now = Date.now()
    if (attempts.size > 1000) for (const [k, count] of attempts) if (count.expiresAt <= now) attempts.delete(k)
    if (attempts.size > 2000 && !attempts.has(key)) throw new ProductError(429, 'Too many sign-in attempts')
    const entry = attempts.get(key)
    const count = entry?.expiresAt > now ? entry : { attempts: 0, expiresAt: now + 60_000 }
    if (++count.attempts > 12) throw new ProductError(429, 'Too many sign-in attempts')
    attempts.set(key, count)
  }

  async function legacy(req, res, releases) {
    const actor = await id.fromEngine(req.headers['x-playmat-engine-user'])
    if (!actor) throw new ProductError(401, 'Authentication required')
    gateAccount(res, 'archive', actor, releases)
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
    const releases = []
    void route(req, res, releases).catch(error => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const status = Number.isInteger(error?.status) ? error.status : 500
      if (status >= 500) console.warn('Playmat product request failed', { status, code: typeof error?.code === 'string' ? error.code : undefined })
      send(res, status, {
        error: status === 500 ? 'Product service unavailable' : error.message,
        ...(error?.rpcCode === -32015 ? { rpcCode: -32015, reason: error.reason } : {}),
      })
    }).finally(() => {
      for (const release of releases) release()
    })
  })

  async function route(req, res, releases) {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    const proxied = Boolean(req.headers['x-playmat-client-ip'])
    // The only public path into this namespace is a Caddy-generated forward_auth check.
    if (proxied && path.startsWith('/internal/') && path !== '/internal/verify') throw new ProductError(404, 'Not found')
    const group = productLimitGroup(path, req.method, proxied, url.searchParams.get('scope'))
    throttleRequest(res, checkSource(group, clientKey(req)))
    if (group === 'socket' && req.headers.origin) {
      const allowed = publicUrl ? new URL(publicUrl).origin : null
      if (allowed && req.headers.origin !== allowed) throw new ProductError(403, 'Origin not allowed')
    }
    if (path === '/healthz' && req.method === 'GET') {
      await pool.query('SELECT 1')
      return send(res, 200, { status: 'ok' })
    }
    if (await oauth.route(req, res, url, id.resolve)) return
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req, insecureCookie)) throw new ProductError(403, 'Cross-origin request')
    if (await spectatorRoute(req,res,path,id.resolve,spectators,send)) return
    if (path === '/api/playtesting/signup/config' && req.method === 'GET') {
      return send(res, 200, { turnstileSiteKey: challenge?.siteKey ?? null })
    }
    if (path === '/api/playtesting/signup/request' && req.method === 'POST') {
      await registration.request(req, await body(req, 'json', 4096))
      return send(res, 202, {})
    }
    if (path === '/api/playtesting/signup/complete' && req.method === 'POST') {
      const cookie = await registration.complete(req, await body(req, 'json', 2048))
      res.setHeader('Set-Cookie', cookie)
      return send(res, 201, {})
    }
    if (path === '/login' && req.method === 'GET') {
      const next = safeNext(url.searchParams.get('next'))
      if (await id.resolve(req)) return res.writeHead(303, { Location: next }).end()
      return loginPage(res, next, { siteKey: challenge?.siteKey })
    }
    if (path === '/login' && req.method === 'POST') {
      const form = await body(req, 'form', 8192)
      const next = safeNext(form.get('next'))
      const username = form.get('username')
      try {
        await challenge?.verify(form.get('cf-turnstile-response'), loginChallengeAction)
      } catch (error) {
        if (!(error instanceof ProductError)) throw error
        return loginPage(res, next, { siteKey: challenge.siteKey, status: error.status, error: error.message })
      }
      throttle(normalize(username).slice(0, 24))
      const cookie = await id.signIn(username, form.get('password'))
      if (cookie) return res.writeHead(303, { 'Set-Cookie': cookie, Location: next }).end()
      return loginPage(res, next, { siteKey: challenge?.siteKey, status: 401, error: 'Revisa tu usuario y contraseña.' })
    }
    if (path === '/logout' && req.method === 'POST') {
      return res.writeHead(303, { 'Set-Cookie': await id.signOut(req), Location: '/login' }).end()
    }
    if (enableInternal && path === '/internal/legacy' && req.method === 'POST') return legacy(req, res, releases)
    if (enableInternal && path === '/internal/human-seat/restore' && req.method === 'POST') {
      const input = await body(req, 'json', 1024)
      await transaction(pool, async db => {
        await restoreHumanSeat(db,input)
        await restorePlayerReservations(db,input.originalTableId,input.tableId)
        await restoreSpectatorLink(db,input.originalTableId,input.tableId)
      })
      return send(res, 200, {})
    }
    if (enableInternal && path === '/internal/human-seat/manual' && req.method === 'POST') {
      const allowed = await humanBrowserMayPlay(pool, await body(req, 'json', 1024))
      return send(res, allowed ? 200 : 403, { allowed })
    }
    if (enableInternal && path === '/internal/human-seat/authorize' && req.method === 'POST') {
      const allowed = await authorizeHumanConnection(pool, await body(req, 'json', 1024))
      return send(res, allowed ? 200 : 403, { allowed })
    }
    if (enableInternal && path === '/internal/human-seat/table' && req.method === 'POST') {
      await recordHumanSeat(pool, await body(req, 'json', 1024))
      return send(res, 200, {})
    }
    if (enableInternal && path.startsWith('/internal/player-reservations/') && req.method === 'POST') {
      const actor = await id.resolve(req)
      return send(res, 200, await changeReservation(pool,actor,path.slice('/internal/player-reservations/'.length),await body(req,'json',1024)))
    }
    if (enableInternal && path.startsWith('/internal/human-seat/') && req.method === 'POST') {
      const actor = await id.resolve(req)
      if (!actor?.accountAgent) throw new ProductError(403, 'The account MCP connection is required')
      requireScope(actor, 'play')
      if (path === '/internal/human-seat/list') return send(res, 200, await listHumanMatches(pool, actor))
      const [, , , tableId, action] = path.split('/')
      const seat = await readHumanSeat(pool, actor, tableId, { ownerOnly: true })
      if (action === 'settings') return send(res, 200, seat)
      if (action === 'invite' && seat.createdViaMcp) {
        const input = await body(req)
        if (input.tableId !== tableId) throw new ProductError(400, 'Table does not match')
        return send(res, 201, await invitations.create({ ...actor, engineName: seat.humanName, agent: false, accountAgent: false }, input))
      }
      throw new ProductError(404, 'Human match operation unavailable')
    }
    if (enableInternal && path === '/internal/review-capture' && req.method === 'POST') {
      return send(res, 200, await permissions.sealCapture(await body(req, 'json', 8192)))
    }
    // Presentation metadata for the colocated Java social lists, never an authentication decision.
    if (enableInternal && path === '/internal/social/agents' && req.method === 'GET') {
      const { rows } = await pool.query(`SELECT DISTINCT g.engine_key FROM agent_grants g
        WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.username_key=g.engine_key)
        ORDER BY g.engine_key`)
      return send(res, 200, rows.map(row => row.engine_key))
    }
    if (enableInternal && path === '/internal/recovery/validate' && req.method === 'POST') {
      const principal = await body(req, 'json', 1024)
      const valid = await id.validateRecoveryPrincipal(principal)
      return send(res, valid ? 200 : 403, { valid })
    }
    if (enableInternal && path === '/internal/invites' && req.method === 'GET') {
      const result = await pool.query('SELECT table_id FROM invitations WHERE invitee_key=$1 AND expires_at>now() AND NOT unlisted', [
        normalize(url.searchParams.get('guest')),
      ])
      return send(res, 200, result.rows.map(row => row.table_id))
    }
    if (enableInternal && path.startsWith('/internal/invites/') && req.method === 'GET') {
      const tableId = path.slice('/internal/invites/'.length)
      if (!isUuid(tableId)) throw new ProductError(404, 'Invitation not found')
      const host = url.searchParams.get('host')
      const guest = url.searchParams.get('guest')
      const allowed = await (url.searchParams.get('lookup') === 'link'
        ? invitations.canViewByLink(tableId, host, guest)
        : invitations.admit(tableId, host, guest))
      return send(res, allowed ? 200 : 404, { allowed })
    }
    if (enableInternal && path.startsWith('/internal/mcp-events/') && req.method === 'POST') {
      const method = path.slice('/internal/mcp-events/'.length)
      if (method === 'seat') {
        const input = await body(req, 'json', 4096)
        const { operation, accountId, engineName, key, data, expiresAt } = input ?? {}
        if (!isUuid(accountId) || typeof engineName !== 'string' || !/^(?:mcp_)?[a-z0-9_-]{3,24}$/i.test(engineName)
          || typeof key !== 'string' || key.length > 200) throw new ProductError(400, 'Invalid game decision event')
        const notice = { accountId, engineName, key, name: 'game.decision.required' }
        if (operation === 'invalidate') await events.invalidate(pool, notice)
        else if (operation === 'enqueue' && Number.isSafeInteger(expiresAt) && expiresAt > Date.now() && expiresAt < Date.now() + 31_000) {
          await transaction(pool, db => events.enqueue(db, { ...notice, data, expiresAt: new Date(expiresAt) }))
        } else {
          throw new ProductError(400, 'Invalid game decision event')
        }
        return send(res, 200, {})
      }
      if (!['list', 'subscribe', 'unsubscribe'].includes(method)) throw new ProductError(404, 'Not found')
      const actor = await id.resolve(req)
      if (!actor?.agent) throw new ProductError(401, 'A delegated play seat is required')
      requireScope(actor, 'play')
      return send(res, 200, await events[method](actor, await body(req, 'optional-json', 8192)))
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
      if (actor.playerId && proxied && url.searchParams.get('scope') === 'play') throw new ProductError(403,'Use the profile MCP seat')
      const canonicalAgent = !!actor.playerId || (actor.accountAgent === true && normalize(actor.engineName) === 'mcp_' + normalize(actor.username))
      if (canonicalAgent) {
        res.setHeader('X-Playmat-Canonical-Agent', '1')
      }
      res.setHeader('X-Playmat-User', actor.engineName)
      res.setHeader('X-Playmat-Account', actor.accountId)
      const principal = await id.recoveryPrincipal(actor)
      if (principal) res.setHeader('X-Playmat-Seat', principal.seatId)
      if (principal?.connectionId) res.setHeader('X-Playmat-Connection', principal.connectionId)
      return send(res, 200, { ...identityView(actor), ...(canonicalAgent ? { canonicalAgent } : {}), ...(principal ? { recoverySeatId: principal.seatId } : {}) })
    }
    gateAccount(res, group, actor, releases)
    const endpoint = path.slice('/api/playtesting/'.length)
    if (endpoint === 'player-slots' && req.method === 'POST') return send(res,201,await createPlayerSlot(pool,actor,await body(req,'json',2048)))
    if (endpoint === 'players') {
      if (req.method === 'GET') return send(res,200,await listPlayers(pool,actor,url.searchParams.get('availableOnly')==='true'))
      if (req.method === 'POST') return send(res,201,await createPlayer(pool,actor,await body(req,'json',2048)))
    }
    if (req.method === 'PATCH' && /^players\/[^/]+$/.test(endpoint)) {
      return send(res,200,await updatePlayer(pool,actor,endpoint.slice('players/'.length),await body(req,'json',2048)))
    }
    if (endpoint === 'me' && req.method === 'GET') return send(res, 200, identityView(actor))
    if (endpoint.startsWith('human-seat/') && req.method === 'GET') {
      requireScope(actor, 'play')
      return send(res, 200, await readHumanSeat(pool, actor, endpoint.slice('human-seat/'.length)))
    }
    if (endpoint === 'player-identities' && req.method === 'GET') {
      requireScope(actor, 'play')
      return send(res, 200, await id.publicPlayers(url.searchParams.get('names')))
    }
    const reviewAccess = /^review\/privacy\/matches\/([^/]+)$/.exec(endpoint)
    if (reviewAccess) {
      requireScope(actor, 'history')
      if (req.method !== 'GET') throw new ProductError(405, 'Use GET')
      return send(res, 200, await permissions.reviewAccess(actor, reviewAccess[1]))
    }
    if (endpoint === 'decks' || endpoint.startsWith('decks/')) {
      const expectedOwner = req.headers['x-playmat-deck-owner']
      if (expectedOwner && normalize(expectedOwner) !== normalize(actor.username)) throw new ProductError(403, 'The browser session has changed')
    }
    if (endpoint === 'deck-archetypes' && req.method === 'GET') {
      requireScope(actor, 'library')
      return send(res, 200, { archetypes: archetypesFor(url.searchParams.get('format')) })
    }
    if (endpoint === 'decks' && req.method === 'GET') {
      requireScope(actor, 'library')
      const library = url.searchParams.get('library') ?? (actor.playerId ? 'agent' : null)
      if (actor.playerId && library !== 'agent') throw new ProductError(403,'Pilots use the shared MCP library')
      if (library !== null && !['personal', 'agent'].includes(library)) throw new ProductError(400, 'Invalid deck library')
      return send(res, 200, { decks: await listDecks(pool, actor.accountId, url.searchParams.get('deleted') === '1', library) })
    }
    if (endpoint.startsWith('decks/')) {
      requireScope(actor, 'library')
      const libraryMove = /^decks\/[^/]+\/library$/.test(endpoint)
      const deckPath = endpoint.slice('decks/'.length)
      let deckId
      try {
        deckId = decodeURIComponent(libraryMove ? deckPath.slice(0, -'/library'.length) : deckPath)
      } catch {
        throw new ProductError(400, 'Invalid deck ID')
      }
      if (libraryMove) {
        if (req.method !== 'POST') throw new ProductError(405, 'Use POST to move a deck')
        if (actor.agent) throw new ProductError(403, 'Only the owner can move decks between libraries')
        const { library, expectedRevision } = await body(req)
        return send(res, 200, await moveDeckLibrary(pool, actor.accountId, deckId, library, expectedRevision))
      }
      if (req.method === 'GET') {
        const revision = url.searchParams.get('revision')
        if (revision && !/^\d{1,8}$/.test(revision)) throw new ProductError(400, 'Invalid revision')
        return send(res, 200, rejectMissing(await getDeck(pool, actor.accountId, deckId, revision, actor.playerId ? 'agent' : null), 'Deck not found'))
      }
      if (req.method === 'PUT') return send(res, 200, await putDeck(pool, actor.accountId, deckId, await body(req), actor.agent ? 'agent' : 'personal', actor.playerId ? 'agent' : null))
      if (req.method === 'DELETE') {
        const data = await body(req)
        await deleteDeck(pool, actor.accountId, deckId, data.expectedRevision, undefined, actor.playerId ? 'agent' : null)
        return send(res, 200, { deleted: true })
      }
    }
    if (endpoint === 'invites') {
      requireScope(actor, 'play')
      if (req.method === 'GET') return send(res, 200, await invitations.list(actor, url.searchParams.get('limit'),url.searchParams.get('tableId')))
      if (req.method === 'POST') return send(res, 201, await invitations.create(actor, await body(req), {trustedPilot:!proxied}))
    }
    if (endpoint.startsWith('invites/')) {
      requireScope(actor, 'play')
      const [, tableId, action, extra] = endpoint.split('/')
      if (!extra && isUuid(tableId)) {
        if (req.method === 'GET' && action === undefined) return send(res, 200, await invitations.inspect(actor, tableId))
        if (req.method === 'POST' && action === 'claim') return send(res, 200, await invitations.claim(actor, tableId, await body(req, 'optional-json', 4096)))
      }
    }
    const statisticsExclusion = /^matches\/([^/]+)\/statistics-exclusion$/.exec(endpoint)
    if (statisticsExclusion && req.method === 'POST') {
      requireScope(actor, 'history')
      const input = await body(req, 'json', 4096)
      return send(res, 200, await excludeAsParticipant(pool, actor, statisticsExclusion[1], input?.reason))
    }
    if (endpoint === 'matches' && req.method === 'GET') {
      requireScope(actor, 'history')
      const history = await archive.matchList(actor, Object.fromEntries(url.searchParams))
      return send(res, 200, await review.withHistory(actor, history))
    }
    if (req.method === 'POST' && (endpoint === 'theory/studies' || endpoint === 'theory/tactics')) {
      requireScope(actor, 'history')
      const input = await body(req)
      return send(res, 200, endpoint === 'theory/studies' ? await theory.save(actor, input) : evaluateTheoryTactics(input))
    }
    if (req.method === 'GET' && endpoint.startsWith('theory/studies/')) {
      requireScope(actor, 'history')
      return send(res, 200, await theory.read(actor, endpoint.slice('theory/studies/'.length)))
    }
    if (endpoint === 'performance' && req.method === 'GET') {
      requireScope(actor, 'history')
      requireScope(actor, 'library')
      return send(res, 200, await archive.performance(actor, Object.fromEntries(url.searchParams)))
    }
    if (endpoint === 'stats' && req.method === 'GET') {
      requireScope(actor, 'history')
      return send(res, 200, await archive.statistics(actor, url.searchParams.get('format')))
    }
    if (endpoint.startsWith('matches/') && req.method === 'GET') {
      requireScope(actor, 'history')
      const id = endpoint.slice('matches/'.length)
      if (!isUuid(id)) throw new ProductError(404, 'Match not found')
      const history = await archive.matchList(actor, { id, limit: 1 })
      const { matches: [match] } = await review.withHistory(actor, history)
      return send(res, 200, rejectMissing(match, 'Match not found'))
    }
    const matchReview = /^review\/matches\/([^/]+)$/.exec(endpoint)
    if (matchReview && req.method === 'GET') {
      requireScope(actor, 'history')
      return send(res, 200, await review.match(actor, matchReview[1]))
    }
    const gameReview = /^review\/games\/([^/]+)(?:\/(evidence|annotations))?$/.exec(endpoint)
    if (gameReview) {
      requireScope(actor, 'history')
      const [, gameId, resource] = gameReview
      const query = Object.fromEntries(url.searchParams)
      if (req.method === 'GET' && !resource) return send(res, 200, await review.manifest(actor, gameId))
      if (req.method === 'GET' && resource === 'evidence') return send(res, 200, await review.evidence(actor, gameId, query))
      if (req.method === 'GET' && resource === 'annotations') return send(res, 200, await theory.attachAnnotationLinks(actor, await review.listAnnotations(actor, gameId, query)))
      if (req.method === 'POST' && resource === 'annotations') return send(res, 200, await review.saveAnnotations(actor, gameId, await body(req)))
      throw new ProductError(405, 'Use GET for review evidence or POST to save annotations')
    }
    if (endpoint.startsWith('replays/') && req.method === 'GET') {
      requireScope(actor, 'history')
      return send(res, 200, await archive.replayPage(actor, endpoint.slice('replays/'.length), url.searchParams.get('start'), url.searchParams.get('count')))
    }
    if (endpoint.startsWith('evaluations/') && (req.method === 'GET' || req.method === 'POST')) {
      requireScope(actor, 'history')
      const gameId = endpoint.slice('evaluations/'.length)
      if (req.method === 'GET') {
        return send(res, 200, await archive.evaluation(actor, gameId, {
          start: url.searchParams.get('start'), count: url.searchParams.get('count'),
        }))
      }
      const data = await body(req)
      return send(res, 200, await archive.evaluation(actor, gameId, { reviews: data?.positions }))
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
    resetMatchHistory: (username, throughMs) => resetMatchHistory(pool, username, throughMs),
    setUnlimitedMatchHistory: (usernames, unlimited) => setUnlimitedMatchHistory(pool, usernames, unlimited),
    archiveGames: archive.archiveGames,
    startMcpEvents: events.start,
    async dropTestSchema() {
      if (!schema.startsWith('test_')) throw Error('Refusing to remove data outside an isolated test schema')
      await pool.query('DROP SCHEMA ' + schema + ' CASCADE')
    },
    async close() {
      spectators.close()
      await events.stop()
      return pool.end()
    },
  }
}
