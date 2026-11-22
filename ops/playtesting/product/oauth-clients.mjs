import { generateKeyPairSync } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { Provider, errors } from 'oidc-provider'
import { scopesSupported } from './oauth-scopes.mjs'
import { resolveWebhookTarget } from './mcp-events-webhook.mjs'

const loopbacks = new Set(['localhost', '127.0.0.1', '[::1]'])
const invalid = () => new errors.InvalidClientMetadata('Unsupported public MCP client metadata')

// Application policy; the library owns metadata parsing and redirect matching.
function publicClient(metadata, inferNative = false, negotiated = true) {
  if ((negotiated && metadata.token_endpoint_auth_method !== 'none') || metadata.client_secret !== undefined
    || typeof metadata.client_name !== 'string' || !metadata.client_name.trim() || metadata.client_name.length > 100
    || !Array.isArray(metadata.redirect_uris) || !metadata.redirect_uris.length || metadata.redirect_uris.length > 20
    || (negotiated && metadata.grant_types?.some(type => !['authorization_code', 'refresh_token'].includes(type)))
    || (negotiated && metadata.response_types?.some(type => type !== 'code'))
    || metadata.sector_identifier_uri) throw invalid()
  let hasLoopback = false
  for (const value of metadata.redirect_uris) {
    if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value) || /[\s\\*]/.test(value)) throw invalid()
    const url = new URL(value)
    const native = url.protocol === 'http:' && loopbacks.has(url.hostname)
    if ((url.protocol !== 'https:' && !native) || url.username || url.password || value.includes('#')
      || ['code', 'state', 'iss', 'error'].some(key => url.searchParams.has(key))) throw invalid()
    hasLoopback ||= native
  }
  if (inferNative && hasLoopback) metadata.application_type = 'native'
}

// Resolve once, reject every non-public DNS answer, and pin the approved address
// while retaining the hostname for TLS verification. Never follow redirects.
export function metadataTransport({ resolveTarget = resolveWebhookTarget, request = httpsRequest } = {}) {
  return async (value, { signal = AbortSignal.timeout(2500), headers } = {}) => {
    const url = new URL(value)
    if (url.port || url.search || url.hash || url.pathname === '/') throw invalid()
    const target = await Promise.race([
      resolveTarget(value),
      new Promise((_, reject) => {
        if (signal?.aborted) reject(signal.reason)
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ])
    return new Promise((resolve, reject) => {
      const req = request(target.url, {
        method: 'GET', agent: false, autoSelectFamily: false, family: target.family, signal,
        headers: Object.fromEntries(new Headers(headers)),
        lookup: (_hostname, options, done) => options.all
          ? done(null, [{ address: target.address, family: target.family }])
          : done(null, target.address, target.family),
      }, res => {
        const chunks = []
        let length = 0
        res.on('data', chunk => {
          length += chunk.length
          if (length > 32768) { const error = invalid(); reject(error); req.destroy(error) }
          else chunks.push(chunk)
        })
        res.once('error', reject)
        res.once('aborted', () => reject(invalid()))
        res.once('end', () => {
          try {
            if (res.statusCode === 200 && !/^application\/json(?:;|$)/i.test(res.headers['content-type'] ?? '')) throw invalid()
            resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks),
              { status: res.statusCode, headers: res.headers }))
          } catch (error) { reject(error) }
        })
      })
      req.once('error', reject)
      req.end()
    })
  }
}

export function createClientRegistry(pool, issuer, clients = [], { fetch = metadataTransport() } = {}) {
  if (!Array.isArray(clients) || clients.length > 50) throw new Error('Invalid OAuth client registry')
  const configured = clients.map(item => {
    if (typeof item?.clientId !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(item.clientId)) throw invalid()
    const metadata = item.redirectUri ? {
      client_id: item.clientId, client_name: item.name, redirect_uris: [item.redirectUri], token_endpoint_auth_method: 'none',
    } : { ...item, client_id: item.clientId }
    publicClient(metadata, metadata.application_type === undefined)
    return metadata
  })
  // Only the Client adapter and registration route are exposed. All grants,
  // consent and opaque tokens remain in Playmat; no OIDC endpoints are mounted.
  class ClientAdapter {
    constructor(model) {
      if (model !== 'Client') throw new Error('Only OAuth client storage is enabled')
    }
    async find(id) {
      const { rows: [row] } = await pool.query('SELECT metadata FROM oauth_registered_clients WHERE client_id=$1', [id])
      return row?.metadata
    }
    async upsert(id, metadata) {
      await pool.query(`INSERT INTO oauth_registered_clients(client_id,metadata) VALUES ($1,$2)
        ON CONFLICT(client_id) DO UPDATE SET metadata=excluded.metadata`, [id, metadata])
    }
  }
  // oidc-provider requires an algorithm for its Client schema even though we
  // never expose its token/JWKS endpoints or issue signed tokens from it.
  const { privateKey } = generateKeyPairSync('ed25519')
  const provider = new Provider(issuer, {
    adapter: ClientAdapter, clients: configured, fetch,
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'client-registry-only', use: 'sig', alg: 'EdDSA' }] },
    clientDefaults: { token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'EdDSA' },
    clientAuthMethods: ['none'], responseTypes: ['code'], scopes: scopesSupported,
    issueRefreshToken: () => true,
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true, issueRegistrationAccessToken: false },
      clientIdMetadataDocument: {
        enabled: true, ack: 'draft-03', cacheDuration: { min: 0, max: 300 },
        allowClient: (_ctx, client) => { publicClient(client.metadata()); return true },
      },
    },
    extraClientMetadata: {
      properties: ['playmat_client_policy'],
      validator(ctx, _key, _value, metadata) {
        if (ctx && metadata.client_name === undefined) metadata.client_name = 'Cliente MCP'
        // CIMD may publish several methods/grants. Let the library intersect
        // those with our advertised capabilities before checking the result.
        publicClient(metadata, ctx?.oidc.body?.application_type === undefined && Boolean(ctx), false)
        delete metadata.playmat_client_policy
      },
    },
    routes: { registration: '/oauth/register' },
  })
  const register = provider.callback()
  let pending = 0
  let attempts = 0
  let window = Date.now()
  return {
    register,
    async get(id) {
      if (typeof id !== 'string' || id.length > 2048) return undefined
      if (Date.now() - window >= 60_000) { window = Date.now(); attempts = 0 }
      if (pending >= 8 || ++attempts > 300) return undefined
      pending++
      try {
        const client = await provider.Client.find(id)
        if (!client) return undefined
        publicClient(client.metadata())
        const scopes = client.scope ? client.scope.split(' ').filter(scope => scopesSupported.includes(scope)) : scopesSupported
        return { clientId: client.clientId, name: client.clientName, scopes, allows: uri => client.redirectUriAllowed(uri) }
      } catch (error) {
        if (error instanceof errors.OIDCProviderError) return undefined
        throw error
      } finally {
        pending--
      }
    },
    name: id => configured.find(client => client.client_id === id)?.client_name ?? id,
  }
}
