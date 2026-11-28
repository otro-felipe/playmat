import { listPlayers, profileConsent } from './players.mjs'
import { playerPage, renderPlayerForms, savePlayerForm } from './player-profile-forms.mjs'
import { authStyles } from './auth-styles.mjs'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { digest, ensureOAuthAgent, newToken } from './identity.mjs'
import { isUuid, ProductError, transaction } from './decks.mjs'
import { createClientRegistry } from './oauth-clients.mjs'
import { defaultScopes, scopeLabels, scopesSupported } from './oauth-scopes.mjs'

const consentLifetime = 10 * 60
const codeLifetime = 90
const accessLifetime = 15 * 60
const connectionLifetime = 365 * 24 * 60 * 60
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/
const verifierPattern = /^[a-zA-Z0-9_.~-]{43,128}$/
const statePattern = /^[\x21-\x7e]{1,1024}$/
const accountPermissions = ['players:manage', 'tournaments:manage']
const htmlEscapes = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }
const escape = value => String(value).replace(/[<>&"']/g, char => htmlEscapes[char])
const deadline = seconds => new Date(Date.now() + seconds * 1000)

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', Pragma: 'no-cache' })
  res.end(JSON.stringify(data))
}

function html(res, title, content, redirectOrigin = '') {
  const formTargets = redirectOrigin ? "'self' " + redirectOrigin : "'self'"
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action ${formTargets}; frame-ancestors 'none'`,
    // A native consent POST needs its same-origin Origin header for CSRF validation.
    'Referrer-Policy': 'same-origin',
  })
  res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} · Thoughtseize</title><style>
    ${authStyles}
    main{max-width:min(92vw,32rem);margin:8dvh auto}
    form,label{display:grid;gap:.65rem}form+form{margin-top:1rem}
    </style><main><h1>${title}</h1>${content}</main></html>`)
}

function browserOnly(actor) {
  return actor?.agent === false && actor.browserSession ? actor : null
}

function approvedScopes(allowed, requested) {
  if (requested.includes('play') && !allowed.includes('play')) return []
  return requested.filter(scope => allowed.includes(scope))
}

function callback(res, issuer, client, state, result) {
  const target = new URL(client.redirectUri)
  for (const [key, value] of Object.entries({ ...result, state, iss: issuer })) target.searchParams.set(key, value)
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.writeHead(303, { Location: target.href }).end()
}

async function authRequest(params, audience, registry) {
  for (const key of ['client_id', 'redirect_uri', 'resource', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method']) {
    if (params.getAll(key).length > 1) throw new ProductError(400, 'Parámetro OAuth duplicado')
  }
  const redirectUri = params.get('redirect_uri')
  if (params.get('resource') !== audience) throw new ProductError(400, 'Destino OAuth no admitido')
  const registered = await registry.get(params.get('client_id'))
  if (!registered || !registered.allows(redirectUri)) {
    throw new ProductError(400, 'Cliente o destino OAuth no admitido')
  }
  const client = { ...registered, redirectUri }
  const state = params.get('state')
  if (!statePattern.test(state ?? '')) throw new ProductError(400, 'Estado OAuth inválido')
  if (params.get('response_type') !== 'code') return { client, state, error: 'unsupported_response_type' }
  const challenge = params.get('code_challenge')
  if (params.get('code_challenge_method') !== 'S256' || !tokenPattern.test(challenge ?? '')) {
    return { client, state, error: 'invalid_request' }
  }
  const requested = params.get('scope')?.trim()
  const scopes = params.has('scope') ? [...new Set(requested.split(/ +/))] : defaultScopes.filter(scope => client.scopes.includes(scope))
  if (!params.has('scope') && client.scopes.includes('tournaments:manage')) scopes.push('tournaments:manage')
  const allowOptionalManagement = client.scopes.includes('players:manage') && (!params.has('scope') || scopes.includes('players:manage'))
  if ((!scopes.length && !allowOptionalManagement) || scopes.some(scope => !client.scopes.includes(scope))) {
    return { client, state, error: 'invalid_scope' }
  }
  return { client, state, challenge, scopes, allowOptionalManagement }
}

export function createOAuth(pool, publicUrl, { body, clients = [], clientOptions }) {
  const url = publicUrl ? new URL(publicUrl) : null
  if (url?.protocol !== 'https:') return { route: async () => false, resolve: async () => null }
  const issuer = url.origin
  const audience = issuer + '/mcp'
  const registry = createClientRegistry(pool, issuer, clients, clientOptions)

  async function begin(req, res, requestUrl, resolveIdentity) {
    const request = await authRequest(requestUrl.searchParams, audience, registry)
    if (request.error) return callback(res, issuer, request.client, request.state, { error: request.error })
    const owner = browserOnly(await resolveIdentity(req))
    if (!owner) {
      const next = requestUrl.pathname + requestUrl.search
      return res.writeHead(303, { Location: '/login?next=' + encodeURIComponent(next), 'Referrer-Policy': 'no-referrer' }).end()
    }
    const canOfferTournaments = request.scopes.includes('tournaments:manage') &&
      (await pool.query('SELECT 1 FROM accounts WHERE id=$1 AND enabled AND tournament_admin', [owner.accountId])).rowCount === 1
    const requestedScopes = request.scopes.filter(scope => scope !== 'tournaments:manage' || canOfferTournaments)
    if (!requestedScopes.length && !request.allowOptionalManagement) {
      return callback(res, issuer, request.client, request.state, { error:'access_denied' })
    }
    const id = randomUUID()
    await pool.query('DELETE FROM oauth_consent_requests WHERE expires_at<=now()')
    await pool.query(`INSERT INTO oauth_consent_requests(id,browser_session,code_challenge,client_state,client_id,redirect_uri,audience,scopes_requested,expires_at,allow_optional_management)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, owner.browserSession, request.challenge, request.state, request.client.clientId,
      request.client.redirectUri, audience, requestedScopes, deadline(consentLifetime),request.allowOptionalManagement])
    const profiles = (await listPlayers(pool, owner)).players.filter(player => player.mcpEnabled)
    const selectPlayer = profiles.length ? `<label>Acceso de la conexión<select name="playerId"><option value="">Cuenta y jugadores MCP habilitados</option>${profiles.map(p => `<option value="${p.playerId}">${escape(p.displayName)}${p.flag ? ' · '+escape(p.flag) : ''}</option>`).join('')}</select></label>
      <p>Si eliges un jugador por nombre, esta conexión solo podrá controlar a ese jugador y usar la biblioteca MCP compartida.</p>` : ''
    const permissions = requestedScopes.filter(scope => !accountPermissions.includes(scope)).map(scope => `<li>${scopeLabels[scope]}</li>`).join('')
    return html(res, 'Conectar tu cuenta de Thoughtseize', `
      <p>Autoriza a <strong>${escape(request.client.name)}</strong> a usar tu cuenta de Thoughtseize <strong>${escape(owner.username)}</strong> con estos permisos.</p>
      <p>Cliente: ${escape(request.client.clientId)}<br>Destino: <strong>${escape(request.client.redirectUri)}</strong></p>
      ${new URL(request.client.redirectUri).protocol === 'http:' ? '<p>El destino es una aplicación en este dispositivo. Comprueba que abriste esta conexión desde la aplicación que quieres autorizar.</p>' : ''}
      <ul>${permissions}</ul>
      ${request.scopes.includes('play') ? '<p>Con acceso a la cuenta, una misma conexión puede jugar con cada jugador que habilites en Administrar jugadores. También puede controlar tu asiento humano en las mesas donde permitas ese acceso.</p>' : ''}
      <form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${id}">${selectPlayer}
      ${request.allowOptionalManagement ? '<label><input type="checkbox" name="manageSlots" value="yes">Permitir a la conexión de cuenta crear y renombrar jugadores MCP</label>' : ''}
      ${canOfferTournaments ? '<label><input type="checkbox" name="manageTournaments" value="yes">Permitir a la conexión de cuenta crear y comenzar tus torneos y liberar reservas obsoletas de tus propios jugadores</label>' : ''}
      <button name="decision" value="allow">Autorizar</button>
      <button name="decision" value="deny">Cancelar</button></form>`, new URL(request.client.redirectUri).origin)
  }

  async function approve(req, res, resolveIdentity) {
    if (req.headers.origin !== issuer || req.headers['sec-fetch-site'] === 'cross-site') throw new ProductError(403, 'Origen OAuth inválido')
    const owner = browserOnly(await resolveIdentity(req))
    const form = await body(req, 'form', 4096)
    const requestId = form.get('request')
    const decision = form.get('decision')
    if (!owner || !isUuid(requestId) || !['allow', 'deny'].includes(decision) || form.has('seat') || form.getAll('playerId').length > 1) {
      throw new ProductError(400, 'Autorización OAuth vencida')
    }
    const approved = await transaction(pool, async db => {
      const { rows: [request] } = await db.query(`SELECT * FROM oauth_consent_requests
        WHERE id=$1 AND browser_session=$2 AND audience=$3 AND expires_at>now() FOR UPDATE`,
      [requestId, owner.browserSession, audience])
      const registered = request && await registry.get(request.client_id)
      if (!registered || !registered.allows(request.redirect_uri)) throw new ProductError(400, 'Autorización OAuth vencida')
      const client = { ...registered, redirectUri: request.redirect_uri }
      let result = { error: 'access_denied' }
      if (decision === 'allow') {
        const selected = form.get('playerId')
        const pilot = selected ? await profileConsent(db, owner, selected) : null
        const engineKey = pilot?.engine_key ?? await ensureOAuthAgent(db, owner.accountId)
        const canonical=!pilot && engineKey==='mcp_'+owner.username.toLowerCase()
        const allowed=pilot?.scopes ?? (canonical ? scopesSupported : scopesSupported.filter(scope=>!accountPermissions.includes(scope)))
        const requested = request.scopes_requested.filter(scope => !accountPermissions.includes(scope))
        if (canonical && request.allow_optional_management && form.get('manageSlots') === 'yes') requested.push('players:manage')
        if (canonical && request.scopes_requested.includes('tournaments:manage') && form.get('manageTournaments') === 'yes') {
          const {rowCount} = await db.query('SELECT 1 FROM accounts WHERE id=$1 AND enabled AND tournament_admin FOR SHARE',[owner.accountId])
          if (rowCount) requested.push('tournaments:manage')
        }
        const scopes = approvedScopes(allowed.filter(scope => client.scopes.includes(scope)), requested)
        // Consent raises the ceiling only on this account grant. Existing connections keep their approved scopes.
        for (const scope of scopes.filter(scope=>accountPermissions.includes(scope))) {
          await db.query('UPDATE agent_grants SET scopes=array_append(scopes,$2) WHERE engine_key=$1 AND NOT ($2=ANY(scopes))',[engineKey,scope])
        }
        if (!scopes.length) throw new ProductError(400, 'Permisos OAuth vencidos')
        const code = newToken()
        await db.query('DELETE FROM oauth_authorization_codes WHERE expires_at<=now()')
        await db.query(`INSERT INTO oauth_authorization_codes(digest,account_id,engine_key,code_challenge,client_id,redirect_uri,audience,scopes_approved,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [digest(code), owner.accountId, engineKey, request.code_challenge,
          client.clientId, request.redirect_uri, audience, scopes, deadline(codeLifetime)])
        result = { code }
      }
      await db.query('DELETE FROM oauth_consent_requests WHERE id=$1', [requestId])
      return { client, state: request.client_state, result }
    })
    return callback(res, issuer, approved.client, approved.state, approved.result)
  }

  async function useCode(db, form, refreshDigest, client) {
    const verifier = form.get('code_verifier')
    const code = form.get('code')
    const redirectUri = form.get('redirect_uri')
    if (!tokenPattern.test(code ?? '') || !verifierPattern.test(verifier ?? '') || !client.allows(redirectUri)) return null
    const { rows: [grant] } = await db.query(`SELECT k.*,g.scopes AS current_scopes
      FROM oauth_authorization_codes k JOIN agent_grants g ON g.engine_key=k.engine_key AND g.account_id=k.account_id
      JOIN accounts a ON a.id=k.account_id WHERE k.digest=$1 AND k.audience=$2 AND k.client_id=$3 AND k.redirect_uri=$4
      AND k.expires_at>now() AND a.enabled AND g.revoked_at IS NULL AND g.oauth_managed FOR UPDATE OF k FOR SHARE OF g`,
    [digest(code), audience, client.clientId, redirectUri])
    const actualChallenge = createHash('sha256').update(verifier).digest('base64url')
    if (!grant || !timingSafeEqual(Buffer.from(grant.code_challenge), Buffer.from(actualChallenge))) return null
    const scopes = approvedScopes(grant.current_scopes.filter(scope => client.scopes.includes(scope)), grant.scopes_approved)
    if (!scopes.length) return null
    const id = randomUUID()
    await db.query('DELETE FROM oauth_authorization_codes WHERE digest=$1', [grant.digest])
    await db.query(`INSERT INTO oauth_connections(id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, grant.account_id, grant.engine_key, client.clientId, audience, scopes, refreshDigest, deadline(connectionLifetime)])
    // A fresh play consent can resume this identity after its prior connection expired or was revoked.
    if (scopes.includes('play')) {
      await db.query(`UPDATE player_table_reservations r SET connection_id=$1 FROM playable_oauth_seats seat,oauth_connections old
        WHERE seat.connection_id=$1 AND seat.player_id=r.player_id AND old.id=r.connection_id
          AND (old.revoked_at IS NOT NULL OR old.expires_at<=now())`,[id])
    }
    return { id, scopes }
  }

  async function rotate(db, form, refreshDigest, client) {
    const token = form.get('refresh_token')
    if (!tokenPattern.test(token ?? '')) return null
    const { rows: [connection] } = await db.query(`UPDATE oauth_connections c SET refresh_digest=$1, expires_at=$2
      FROM agent_grants g JOIN accounts a ON a.id=g.account_id
      WHERE c.refresh_digest=$3 AND c.audience=$4 AND c.client_id=$5 AND c.expires_at>now() AND c.revoked_at IS NULL
      AND c.engine_key=g.engine_key AND c.account_id=g.account_id AND a.enabled AND g.revoked_at IS NULL AND g.oauth_managed
      AND g.scopes && c.scopes_approved AND (NOT ('play'=ANY(c.scopes_approved)) OR 'play'=ANY(g.scopes))
      AND c.scopes_approved <@ $6::text[]
      RETURNING c.id,c.scopes_approved,g.scopes AS current_scopes`,
    [refreshDigest, deadline(connectionLifetime), digest(token), audience, client.clientId, client.scopes])
    return connection ? { id: connection.id, scopes: approvedScopes(connection.current_scopes, connection.scopes_approved) } : null
  }

  async function token(req, res) {
    const form = await body(req, 'form', 8192)
    const client = await registry.get(form.get('client_id'))
    if (form.getAll('client_id').length !== 1 || !client || req.headers.authorization || form.has('client_secret') || form.has('client_assertion')) {
      return reply(res, 400, { error: 'invalid_client' })
    }
    if (['grant_type', 'code', 'redirect_uri', 'code_verifier', 'refresh_token'].some(key => form.getAll(key).length > 1)) {
      return reply(res, 400, { error: 'invalid_request' })
    }
    const type = form.get('grant_type')
    if (type !== 'authorization_code' && type !== 'refresh_token') return reply(res, 400, { error: 'unsupported_grant_type' })
    const resource = form.get('resource')
    if (form.getAll('resource').length > 1 || (resource !== audience && !(type === 'refresh_token' && resource === null))) {
      return reply(res, 400, { error: 'invalid_target' })
    }
    const accessToken = newToken()
    const refreshToken = newToken()
    const connection = await transaction(pool, async db => {
      const action = type === 'authorization_code' ? useCode : rotate
      const approved = await action(db, form, digest(refreshToken), client)
      if (!approved) return null
      await db.query('DELETE FROM oauth_access_tokens WHERE expires_at<=now()')
      await db.query('INSERT INTO oauth_access_tokens(digest,connection_id,expires_at) VALUES ($1,$2,$3)',
        [digest(accessToken), approved.id, deadline(accessLifetime)])
      return approved
    })
    if (!connection) return reply(res, 400, { error: 'invalid_grant' })
    return reply(res, 200, {
      token_type: 'Bearer', access_token: accessToken, refresh_token: refreshToken,
      expires_in: accessLifetime, scope: connection.scopes.join(' '),
    })
  }

  async function revoke(req, res) {
    const form = await body(req, 'form', 8192)
    const client = await registry.get(form.get('client_id'))
    if (!client || req.headers.authorization || form.getAll('client_id').length !== 1 || form.getAll('token').length !== 1
      || form.has('client_secret') || form.has('client_assertion')) return reply(res, 400, { error: 'invalid_client' })
    const token = form.get('token')
    if (tokenPattern.test(token ?? '')) {
      await pool.query(`UPDATE oauth_connections SET revoked_at=now() WHERE audience=$1 AND client_id=$3 AND revoked_at IS NULL
        AND (refresh_digest=$2 OR id=(SELECT connection_id FROM oauth_access_tokens WHERE digest=$2 AND expires_at>now()))`,
      [audience, digest(token), client.clientId])
    }
    return res.writeHead(200).end()
  }

  async function connections(req, res, resolveIdentity, playersView) {
    const owner = browserOnly(await resolveIdentity(req))
    if (!owner && req.method === 'GET') return res.writeHead(303, { Location: '/login?next=' + encodeURIComponent(playersView ? playerPage : '/oauth/connections') }).end()
    if (!owner) throw new ProductError(401, 'Inicia sesión en Thoughtseize')
    if (req.method === 'POST') {
      if (req.headers.origin !== issuer || req.headers['sec-fetch-site'] === 'cross-site') throw new ProductError(403, 'Origen OAuth inválido')
      const form = await body(req, 'form', 4096)
      if (playersView) {
        await savePlayerForm(pool, owner, form)
        return res.writeHead(303, { Location: playerPage }).end()
      }
      const id = form.get('connection')
      if (!isUuid(id)) throw new ProductError(400, 'Conexión inválida')
      const revoked = await pool.query('UPDATE oauth_connections SET revoked_at=now() WHERE id=$1 AND audience=$2 AND account_id=$3 AND revoked_at IS NULL',
        [id, audience, owner.accountId])
      if (!revoked.rowCount) throw new ProductError(404, 'Conexión no encontrada')
      return res.writeHead(303, { Location: '/oauth/connections' }).end()
    }
    if (playersView) {
      const { players } = await listPlayers(pool, owner)
      return html(res, 'Jugadores', renderPlayerForms(players, escape))
    }
    const { rows } = await pool.query(`SELECT c.id,c.client_id,c.scopes_approved,g.scopes,p.display_name FROM oauth_connections c JOIN agent_grants g
      ON g.engine_key=c.engine_key AND g.account_id=c.account_id LEFT JOIN player_profiles p ON p.id=g.player_id AND p.account_id=g.account_id WHERE c.audience=$1 AND c.account_id=$2
      AND c.revoked_at IS NULL AND c.expires_at>now() AND g.revoked_at IS NULL AND g.oauth_managed ORDER BY c.created_at DESC`,
    [audience, owner.accountId])
    const entries = rows.map(row => `<form method="post"><input type="hidden" name="connection" value="${escape(row.id)}">
      <strong>${row.display_name ? 'Jugador MCP · '+escape(row.display_name) : 'Conexión de cuenta'}</strong>
      <span>${escape(registry.name(row.client_id))} · ${approvedScopes(row.scopes, row.scopes_approved).map(scope => scopeLabels[scope]).join(', ')}</span>
      <button>Desconectar</button></form>`).join('')
    return html(res, 'Conexiones MCP', `<p><a href="${playerPage}">Administrar jugadores</a></p>` + (entries || '<p>No tienes conexiones activas.</p>'))
  }

  async function route(req, res, requestUrl, resolveIdentity) {
    const path = requestUrl.pathname
    const machine = ['/oauth/token', '/oauth/revoke', '/oauth/register'].includes(path)
    if (machine || path.startsWith('/.well-known/oauth-')) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', machine ? 'POST, OPTIONS' : 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return true }
    }
    const get = req.method === 'GET'
    const post = req.method === 'POST'
    if (get && ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'].includes(path)) {
      reply(res, 200, { resource: audience, authorization_servers: [issuer], scopes_supported: scopesSupported, bearer_methods_supported: ['header'] })
    } else if (get && path === '/.well-known/oauth-authorization-server') {
      reply(res, 200, {
        issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token',
        revocation_endpoint: issuer + '/oauth/revoke', authorization_response_iss_parameter_supported: true,
        registration_endpoint: issuer + '/oauth/register',
        client_id_metadata_document_supported: true, response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: scopesSupported,
      })
    } else if (path === '/oauth/register' && post) {
      await pool.query("DELETE FROM oauth_registration_limits WHERE hour<now()-interval '1 day'")
      const { rows: [limit] } = await pool.query(`INSERT INTO oauth_registration_limits(hour,attempts) VALUES (date_trunc('hour',now()),1)
        ON CONFLICT(hour) DO UPDATE SET attempts=oauth_registration_limits.attempts+1 RETURNING attempts`)
      if (limit.attempts > 200) reply(res, 429, { error: 'temporarily_unavailable' })
      else await registry.register(req, res)
    } else if (path === '/oauth/authorize' && get) await begin(req, res, requestUrl, resolveIdentity)
    else if (path === '/oauth/authorize' && post) await approve(req, res, resolveIdentity)
    else if (path === '/oauth/token' && post) await token(req, res)
    else if (path === '/oauth/revoke' && post) await revoke(req, res)
    else if (path === '/oauth/connections' && (get || post)) await connections(req, res, resolveIdentity, requestUrl.searchParams.get('view') === 'players')
    else return false
    return true
  }

  async function resolve(accessDigest) {
    const { rows: [row] } = await pool.query(`SELECT a.id,a.username,g.engine_name,g.player_id,p.flag AS player_flag,p.display_name,r.reservation_id,r.table_id,r.started,r.cancel_pending,r.connection_id AS lease_holder,c.id AS connection_id,
      ARRAY(SELECT legacy.engine_key FROM agent_grants legacy WHERE legacy.successor_key=g.engine_key
        AND legacy.account_id=g.account_id AND legacy.oauth_managed) AS previous_seats,
      g.scopes AS current_scopes,c.scopes_approved,c.client_id FROM oauth_access_tokens t
      JOIN oauth_connections c ON c.id=t.connection_id JOIN accounts a ON a.id=c.account_id
      JOIN agent_grants g ON g.engine_key=c.engine_key AND g.account_id=c.account_id
      LEFT JOIN player_profiles p ON p.id=g.player_id
      LEFT JOIN player_table_reservations r ON r.player_id=g.player_id
      WHERE t.digest=$1 AND t.expires_at>now() AND c.audience=$2 AND c.expires_at>now() AND c.revoked_at IS NULL
      AND a.enabled AND g.revoked_at IS NULL AND g.oauth_managed`, [accessDigest, audience])
    if (!row) return null
    const scopes = approvedScopes(row.current_scopes, row.scopes_approved)
    return scopes.length ? { accountId: row.id, username: row.username, engineName: row.engine_name,
      scopes, agent: true, ...(row.player_id ? {playerId:row.player_id,displayName:row.display_name,flag:row.player_flag,activeTableId:row.table_id,
        ownsReservation:!row.lease_holder || row.lease_holder === row.connection_id,
        ...(row.lease_holder === row.connection_id ? {reservationId:row.reservation_id,reservationStarted:row.started,reservationCancelPending:row.cancel_pending} : {})} : {accountAgent:true,previousSeatNames:row.previous_seats}), connectionId: row.connection_id } : null
  }

  return { route, resolve }
}
