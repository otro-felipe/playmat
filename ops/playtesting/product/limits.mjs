import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'

export function clientKey(req) {
  const forwarded = req.headers['x-playmat-client-ip']
  const address = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress
  if (isIP(address) !== 6 || address.includes('%')) return address ?? 'unknown'
  const canonical = new URL('http://[' + address + ']').hostname.slice(1, -1)
  const [prefix, suffix] = canonical.split('::')
  const leading = prefix ? prefix.split(':') : []
  const trailing = suffix ? suffix.split(':') : []
  if (suffix !== undefined) leading.push(...Array(8 - leading.length - trailing.length).fill('0'), ...trailing)
  if (leading.slice(0, 5).every(part => part === '0') && leading[5] === 'ffff') {
    return leading.slice(6).flatMap(part => {
      const word = Number.parseInt(part, 16)
      return [word >> 8, word & 255]
    }).join('.')
  }
  return leading.slice(0, 4).join(':') + '::/64'
}

export function createLimits(policies, { now = () => performance.now(), maxClients = 4096 } = {}) {
  const groups = new Map(Object.entries(policies).map(([name, policy]) => [name, {
    ...policy, clients: new Map(), nextSweep: 0, totalBucket: undefined,
  }]))
  function refill(bucket, capacity, window, at) {
    return Math.min(capacity, (bucket?.tokens ?? capacity) + (at - (bucket?.at ?? at)) * capacity / window)
  }
  return (name, client) => {
    const group = groups.get(name)
    if (!group) return 0
    const at = now()
    const { clients, window, total, client: capacity } = group
    const totalTokens = refill(group.totalBucket, total, window, at)
    if (totalTokens < 1) return Math.max(1, Math.ceil((1 - totalTokens) * window / total / 1000))
    if (at >= group.nextSweep) {
      for (const [key, bucket] of clients) if (at - bucket.at >= window) clients.delete(key)
      group.nextSweep = at + Math.min(window, 1000)
    }
    const bucket = clients.get(client)
    if (!bucket && clients.size >= maxClients) return Math.ceil(window / 1000)
    const tokens = refill(bucket, capacity, window, at)
    if (tokens < 1) return Math.max(1, Math.ceil((1 - tokens) * window / capacity / 1000))
    clients.set(client, { tokens: tokens - 1, at })
    group.totalBucket = { tokens: totalTokens - 1, at }
    return 0
  }
}

export function createConcurrencyLimit(total, perClient) {
  let active = 0
  const clients = new Map()
  return key => {
    const count = clients.get(key) ?? 0
    if (active >= total || count >= perClient) return undefined
    active++
    clients.set(key, count + 1)
    return () => {
      active--
      const remaining = clients.get(key) - 1
      if (remaining) clients.set(key, remaining)
      else clients.delete(key)
    }
  }
}

const minute = 60_000
export const productLimits = {
  login: { client: 18, total: 150, window: minute },
  signup: { client: 20, total: 90, window: minute },
  oauthRegister: { client: 12, total: 60, window: minute },
  oauth: { client: 60, total: 600, window: minute },
  socket: { client: 36, total: 360, window: minute },
  archive: { client: 90, total: 900, window: minute },
  export: { client: 12, total: 60, window: minute },
  theory: { client: 25, total: 120, window: minute },
  game: { client: 80, total: 600, window: minute },
  decks: { client: 100, total: 1000, window: minute },
  read: { client: 180, total: 1800, window: minute },
}

export const accountLimits = {
  archive: { client: 60, total: 720, window: minute },
  export: { client: 5, total: 40, window: minute },
  theory: { client: 12, total: 90, window: minute },
  game: { client: 45, total: 480, window: minute },
  decks: { client: 60, total: 800, window: minute },
}

export function productLimitGroup(path, method, proxied = false, scope = null) {
  if (path === '/login' && method === 'POST') return 'login'
  if (path === '/oauth/register' && method === 'POST') return 'oauthRegister'
  if (path.startsWith('/oauth/')) return 'oauth'
  if (path === '/internal/verify' && proxied) return scope === 'play' ? 'socket' : 'read'
  if (!path.startsWith('/api/playtesting/')) return undefined
  const endpoint = path.slice('/api/playtesting/'.length)
  const [family] = endpoint.split('/')
  // Colocated MCP pilots all have the same loopback address. Their authenticated
  // tournament heartbeats are limited per seat in the tournament router.
  if (!proxied && method==='POST' && /^tournaments\/[a-f0-9-]{36}\/wait$/i.test(endpoint)) return undefined
  if (family === 'signup') return method === 'POST' ? 'signup' : 'read'
  if (family === 'exports') return 'export'
  if (['review', 'replays', 'evaluations', 'matches', 'stats', 'statistics'].includes(family)
    || /^tournaments\/[^/]+\/statistics$/.test(endpoint)) return 'archive'
  if (family === 'theory') return 'theory'
  if (family === 'invites') return 'game'
  if (family === 'decks' && method !== 'GET') return 'decks'
  return 'read'
}
