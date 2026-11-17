import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { digest, newToken } from './identity.mjs'
import { isUuid, normalize, ProductError, transaction } from './decks.mjs'

const chatgpt = {
  clientId: 'https://chatgpt.com/oauth/client.json',
  redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
  name: 'ChatGPT',
}
const consentLifetime = 10 * 60
const codeLifetime = 90
const accessLifetime = 15 * 60
const connectionLifetime = 30 * 24 * 60 * 60
const scopeLabels = { play: 'juego e invitaciones', chat: 'chat de partida', library: 'mazos de la cuenta', history: 'historial de la cuenta' }
const scopesSupported = Object.keys(scopeLabels)
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/
const verifierPattern = /^[a-zA-Z0-9_.~-]{43,128}$/
const statePattern = /^[\x21-\x7e]{1,1024}$/
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
    'Referrer-Policy': 'no-referrer',
  })
  res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} · Playmat</title><style>
    :root{color-scheme:dark;font:16px system-ui;background:#171c18;color:#f5f3ed}
    main{box-sizing:border-box;max-width:min(92vw,32rem);margin:8dvh auto;padding:2rem;background:#222b24;border:1px solid #405043;border-radius:1rem}
    form,label{display:grid;gap:.65rem}form+form{margin-top:1rem}
    select,button{border:1px solid #687568;border-radius:.5rem;padding:.75rem;color:inherit;background:#18201a;font:inherit}
    button{cursor:pointer}button[value="allow"]{background:#c6dfaf;color:#182018;font-weight:650}
    </style><main><h1>${title}</h1>${content}</main></html>`)
}

function browserOnly(actor) {
  return actor?.agent === false && actor.browserSession ? actor : null
}

function approvedScopes(allowed, requested) {
  if (requested.includes('play') && !allowed.includes('play')) return []
  return requested.filter(scope => allowed.includes(scope))
}

function registeredClients(clients) {
  if (!Array.isArray(clients) || clients.length > 50) throw new Error('Invalid OAuth client registry')
  const registry = new Map([[chatgpt.clientId, chatgpt]])
  for (const item of clients) {
    if (typeof item?.clientId !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(item.clientId) || registry.has(item.clientId)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || typeof item.redirectUri !== 'string') {
      throw new Error('Invalid OAuth client configuration')
    }
    const callback = new URL(item.redirectUri)
    const loopback = callback.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(callback.hostname) && Boolean(callback.port)
    if ((callback.protocol !== 'https:' && !loopback) || callback.username || callback.password || callback.search || callback.hash
      || callback.href !== item.redirectUri) throw new Error('Invalid OAuth client callback')
    registry.set(item.clientId, item)
  }
  return registry
}

function callback(res, issuer, client, state, result) {
  const target = new URL(client.redirectUri)
  target.search = new URLSearchParams({ ...result, state, iss: issuer })
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.writeHead(303, { Location: target.href }).end()
}

function authRequest(params, audience, registry) {
  for (const key of ['client_id', 'redirect_uri', 'resource', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method']) {
    if (params.getAll(key).length > 1) throw new ProductError(400, 'Parámetro OAuth duplicado')
  }
  const client = registry.get(params.get('client_id'))
  if (!client || params.get('redirect_uri') !== client.redirectUri || params.get('resource') !== audience) {
    throw new ProductError(400, 'Cliente o destino OAuth no admitido')
  }
  const state = params.get('state')
  if (!statePattern.test(state ?? '')) throw new ProductError(400, 'Estado OAuth inválido')
  if (params.get('response_type') !== 'code') return { client, state, error: 'unsupported_response_type' }
  const challenge = params.get('code_challenge')
  if (params.get('code_challenge_method') !== 'S256' || !tokenPattern.test(challenge ?? '')) {
    return { client, state, error: 'invalid_request' }
  }
  const scopes = [...new Set((params.get('scope') ?? 'play').trim().split(/ +/))]
  if (scopes.some(scope => !scopesSupported.includes(scope))) return { client, state, error: 'invalid_scope' }
  return { client, state, challenge, scopes }
}

export function createOAuth(pool, publicUrl, { body, clients = [] }) {
  const url = publicUrl ? new URL(publicUrl) : null
  if (url?.protocol !== 'https:') return { route: async () => false, resolve: async () => null }
  const issuer = url.origin
  const audience = issuer + '/mcp'
  const registry = registeredClients(clients)

  async function begin(req, res, requestUrl, resolveIdentity) {
    const request = authRequest(requestUrl.searchParams, audience, registry)
    if (request.error) return callback(res, issuer, request.client, request.state, { error: request.error })
    const owner = browserOnly(await resolveIdentity(req))
    if (!owner) {
      const next = requestUrl.pathname + requestUrl.search
      return res.writeHead(303, { Location: '/login?next=' + encodeURIComponent(next), 'Referrer-Policy': 'no-referrer' }).end()
    }
    const { rows } = await pool.query(`SELECT engine_name,scopes FROM agent_grants
      WHERE account_id=$1 AND revoked_at IS NULL AND scopes && $2::text[] ORDER BY engine_name`, [owner.accountId, request.scopes])
    const agents = rows.map(agent => ({ name: agent.engine_name, scopes: approvedScopes(agent.scopes, request.scopes) }))
      .filter(agent => agent.scopes.length)
    if (!agents.length) return html(res, 'Conectar un agente MCP',
      '<p>Tu cuenta todavía no tiene un asiento de agente habilitado. Pídele uno al administrador de Playmat y vuelve a iniciar la conexión.</p>')
    const id = randomUUID()
    await pool.query('DELETE FROM oauth_consent_requests WHERE expires_at<=now()')
    await pool.query(`INSERT INTO oauth_consent_requests(id,browser_session,code_challenge,client_state,client_id,redirect_uri,audience,scopes_requested,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, owner.browserSession, request.challenge, request.state, request.client.clientId,
      request.client.redirectUri, audience, request.scopes, deadline(consentLifetime)])
    const options = agents.map(agent => `<option value="${escape(agent.name)}">${escape(agent.name)} (${agent.scopes.map(scope => scopeLabels[scope]).join(', ')})</option>`).join('')
    return html(res, 'Conectar un agente MCP', `
      <p>Elige el asiento que podrá usar <strong>${escape(request.client.name)}</strong>. Cada opción muestra los permisos que autorizas para esa conexión.</p>
      <form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${id}">
      <label>Asiento de agente<select name="seat" required>${options}</select></label>
      <button name="decision" value="allow">Autorizar</button>
      <button name="decision" value="deny">Cancelar</button></form>`, new URL(request.client.redirectUri).origin)
  }

  async function approve(req, res, resolveIdentity) {
    if (req.headers.origin !== issuer) throw new ProductError(403, 'Origen OAuth inválido')
    const owner = browserOnly(await resolveIdentity(req))
    const form = await body(req, 'form', 4096)
    const requestId = form.get('request')
    const decision = form.get('decision')
    if (!owner || !isUuid(requestId) || !['allow', 'deny'].includes(decision)) throw new ProductError(400, 'Autorización OAuth vencida')
    const approved = await transaction(pool, async db => {
      const { rows: [request] } = await db.query(`SELECT * FROM oauth_consent_requests
        WHERE id=$1 AND browser_session=$2 AND audience=$3 AND expires_at>now() FOR UPDATE`,
      [requestId, owner.browserSession, audience])
      const client = request && registry.get(request.client_id)
      if (!client || request.redirect_uri !== client.redirectUri) throw new ProductError(400, 'Autorización OAuth vencida')
      let result = { error: 'access_denied' }
      if (decision === 'allow') {
        const { rows: [agent] } = await db.query(`SELECT engine_key,scopes FROM agent_grants
          WHERE account_id=$1 AND engine_key=$2 AND revoked_at IS NULL`,
        [owner.accountId, normalize(form.get('seat'))])
        const scopes = approvedScopes(agent?.scopes ?? [], request.scopes_requested)
        if (!agent || !scopes.length) throw new ProductError(400, 'Elige uno de tus asientos de agente')
        const code = newToken()
        await db.query('DELETE FROM oauth_authorization_codes WHERE expires_at<=now()')
        await db.query(`INSERT INTO oauth_authorization_codes(digest,account_id,engine_key,code_challenge,client_id,redirect_uri,audience,scopes_approved,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [digest(code), owner.accountId, agent.engine_key, request.code_challenge,
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
    if (!tokenPattern.test(code ?? '') || !verifierPattern.test(verifier ?? '') || form.get('redirect_uri') !== client.redirectUri) return null
    const { rows: [grant] } = await db.query(`SELECT k.*,g.scopes AS current_scopes
      FROM oauth_authorization_codes k JOIN agent_grants g ON g.engine_key=k.engine_key AND g.account_id=k.account_id
      JOIN accounts a ON a.id=k.account_id WHERE k.digest=$1 AND k.audience=$2 AND k.client_id=$3 AND k.redirect_uri=$4
      AND k.expires_at>now() AND a.enabled AND g.revoked_at IS NULL FOR UPDATE OF k`,
    [digest(code), audience, client.clientId, client.redirectUri])
    const actualChallenge = createHash('sha256').update(verifier).digest('base64url')
    if (!grant || !timingSafeEqual(Buffer.from(grant.code_challenge), Buffer.from(actualChallenge))) return null
    const scopes = approvedScopes(grant.current_scopes, grant.scopes_approved)
    if (!scopes.length) return null
    const id = randomUUID()
    await db.query('DELETE FROM oauth_authorization_codes WHERE digest=$1', [grant.digest])
    await db.query(`INSERT INTO oauth_connections(id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, grant.account_id, grant.engine_key, client.clientId, audience, scopes, refreshDigest, deadline(connectionLifetime)])
    return { id, scopes }
  }

  async function rotate(db, form, refreshDigest, client) {
    const token = form.get('refresh_token')
    if (!tokenPattern.test(token ?? '')) return null
    const { rows: [connection] } = await db.query(`UPDATE oauth_connections c SET refresh_digest=$1, expires_at=$2
      FROM agent_grants g JOIN accounts a ON a.id=g.account_id
      WHERE c.refresh_digest=$3 AND c.audience=$4 AND c.client_id=$5 AND c.expires_at>now() AND c.revoked_at IS NULL
      AND c.engine_key=g.engine_key AND c.account_id=g.account_id AND a.enabled AND g.revoked_at IS NULL
      AND g.scopes && c.scopes_approved AND (NOT ('play'=ANY(c.scopes_approved)) OR 'play'=ANY(g.scopes))
      RETURNING c.id,c.scopes_approved,g.scopes AS current_scopes`,
    [refreshDigest, deadline(connectionLifetime), digest(token), audience, client.clientId])
    return connection ? { id: connection.id, scopes: approvedScopes(connection.current_scopes, connection.scopes_approved) } : null
  }

  async function token(req, res) {
    const form = await body(req, 'form', 8192)
    const client = registry.get(form.get('client_id'))
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
    const client = registry.get(form.get('client_id'))
    if (!client || req.headers.authorization) return reply(res, 400, { error: 'invalid_client' })
    const token = form.get('token')
    if (tokenPattern.test(token ?? '')) {
      await pool.query(`UPDATE oauth_connections SET revoked_at=now() WHERE audience=$1 AND client_id=$3 AND revoked_at IS NULL
        AND (refresh_digest=$2 OR id=(SELECT connection_id FROM oauth_access_tokens WHERE digest=$2 AND expires_at>now()))`,
      [audience, digest(token), client.clientId])
    }
    return res.writeHead(200).end()
  }

  async function connections(req, res, resolveIdentity) {
    const owner = browserOnly(await resolveIdentity(req))
    if (!owner && req.method === 'GET') return res.writeHead(303, { Location: '/login?next=%2Foauth%2Fconnections' }).end()
    if (!owner) throw new ProductError(401, 'Inicia sesión en Playmat')
    if (req.method === 'POST') {
      if (req.headers.origin !== issuer) throw new ProductError(403, 'Origen OAuth inválido')
      const form = await body(req, 'form', 4096)
      const id = form.get('connection')
      if (!isUuid(id)) throw new ProductError(400, 'Conexión inválida')
      const revoked = await pool.query('UPDATE oauth_connections SET revoked_at=now() WHERE id=$1 AND audience=$2 AND account_id=$3 AND revoked_at IS NULL',
        [id, audience, owner.accountId])
      if (!revoked.rowCount) throw new ProductError(404, 'Conexión no encontrada')
      return res.writeHead(303, { Location: '/oauth/connections' }).end()
    }
    const { rows } = await pool.query(`SELECT c.id,g.engine_name,c.client_id FROM oauth_connections c JOIN agent_grants g
      ON g.engine_key=c.engine_key AND g.account_id=c.account_id WHERE c.audience=$1 AND c.account_id=$2
      AND c.revoked_at IS NULL AND c.expires_at>now() AND g.revoked_at IS NULL ORDER BY c.created_at DESC`,
    [audience, owner.accountId])
    const entries = rows.map(row => `<form method="post"><input type="hidden" name="connection" value="${escape(row.id)}">
      <span>${escape(row.engine_name)} · ${escape(registry.get(row.client_id)?.name ?? 'Cliente MCP')}</span><button>Desconectar</button></form>`).join('')
    return html(res, 'Conexiones MCP', entries || '<p>No tienes conexiones activas.</p>')
  }

  async function route(req, res, requestUrl, resolveIdentity) {
    const path = requestUrl.pathname
    const get = req.method === 'GET'
    const post = req.method === 'POST'
    if (get && ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'].includes(path)) {
      reply(res, 200, { resource: audience, authorization_servers: [issuer], scopes_supported: scopesSupported, bearer_methods_supported: ['header'] })
    } else if (get && path === '/.well-known/oauth-authorization-server') {
      reply(res, 200, {
        issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token',
        revocation_endpoint: issuer + '/oauth/revoke', authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true, response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: scopesSupported,
      })
    } else if (path === '/oauth/authorize' && get) await begin(req, res, requestUrl, resolveIdentity)
    else if (path === '/oauth/authorize' && post) await approve(req, res, resolveIdentity)
    else if (path === '/oauth/token' && post) await token(req, res)
    else if (path === '/oauth/revoke' && post) await revoke(req, res)
    else if (path === '/oauth/connections' && (get || post)) await connections(req, res, resolveIdentity)
    else return false
    return true
  }

  async function resolve(accessDigest) {
    const { rows: [row] } = await pool.query(`SELECT a.id,a.username,g.engine_name,c.id AS connection_id,
      g.scopes AS current_scopes,c.scopes_approved,c.client_id FROM oauth_access_tokens t
      JOIN oauth_connections c ON c.id=t.connection_id JOIN accounts a ON a.id=c.account_id
      JOIN agent_grants g ON g.engine_key=c.engine_key AND g.account_id=c.account_id
      WHERE t.digest=$1 AND t.expires_at>now() AND c.audience=$2 AND c.expires_at>now() AND c.revoked_at IS NULL
      AND a.enabled AND g.revoked_at IS NULL`, [accessDigest, audience])
    if (!row || !registry.has(row.client_id)) return null
    const scopes = approvedScopes(row.current_scopes, row.scopes_approved)
    return scopes.length ? { accountId: row.id, username: row.username, engineName: row.engine_name,
      scopes, agent: true, connectionId: row.connection_id } : null
  }

  return { route, resolve }
}
