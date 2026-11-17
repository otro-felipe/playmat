import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { normalize, ProductError, transaction } from './decks.mjs'

const derive = promisify(scrypt)
const saltPattern = /^[a-z0-9_-]{22}$/i
const digestPattern = /^[a-z0-9_-]{43}$/i
const usernamePattern = /^[a-z0-9_-]{3,24}$/i
const allScopes = ['play', 'library', 'history', 'chat']
const browserDuration = 1000 * 60 * 60 * 24 * 7
const dummyHash = 'AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const prehashedPasswordPattern = /^[a-z0-9_-]{22}\.[a-z0-9_-]{43}$/i
const tokenDigestPattern = /^[a-f0-9]{64}$/

export const digest = token => createHash('sha256').update(token).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')

async function hashPassword(password, salt = randomBytes(16).toString('base64url')) {
  const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  return salt + '.' + key.toString('base64url')
}

async function verifyPassword(password, hash) {
  const [salt, encoded] = hash.split('.')
  if (!saltPattern.test(salt) || !digestPattern.test(encoded)) return false
  const candidate = await hashPassword(password, salt)
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(hash))
}

function validateProvisionList(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new ProductError(400, 'Invalid provisioning bundle')
  }
  const { accounts = [], agents = [], revocations = [] } = bundle
  if ([accounts, agents, revocations].some(rows => !Array.isArray(rows) || rows.length > 16)) {
    throw new ProductError(400, 'Invalid provisioning bundle')
  }
  return { accounts, agents, revocations }
}

function validName(name) {
  return typeof name === 'string' && usernamePattern.test(name)
}

function validScopes(scopes) {
  return Array.isArray(scopes) && scopes.length > 0 && scopes.length <= allScopes.length
    && scopes.every(scope => allScopes.includes(scope))
}

export async function prepareProvisionBundle(bundle) {
  const { accounts, agents, revocations } = validateProvisionList(bundle)
  const users = []
  for (const user of accounts) {
    if (!validName(user?.username) || typeof user.password !== 'string' || user.password.length < 12 || user.password.length > 128) {
      throw new ProductError(400, 'Invalid credential for a manual account')
    }
    users.push({ username: user.username, passwordHash: await hashPassword(user.password) })
  }
  const verified = agents.map(agent => {
    if (!validName(agent?.owner) || !validName(agent.engineName) || typeof agent.token !== 'string'
      || !digestPattern.test(agent.token) || !validScopes(agent.scopes)) {
      throw new ProductError(400, 'Invalid manual agent credential')
    }
    return { owner: agent.owner, engineName: agent.engineName, tokenDigest: digest(agent.token), scopes: [...new Set(agent.scopes)] }
  })
  const revoked = revocations.map(revocation => {
    if (typeof revocation?.token !== 'string' || !digestPattern.test(revocation.token)) {
      throw new ProductError(400, 'Invalid manual agent revocation')
    }
    return { tokenDigest: digest(revocation.token) }
  })
  return { accounts: users, agents: verified, revocations: revoked }
}

export function createIdentity(pool, insecureCookie, resolveOAuth = async () => null) {
  const cookieName = insecureCookie ? 'playmat-session' : '__Host-playmat-session'
  const attributes = '; Path=/; HttpOnly; SameSite=Lax' + (insecureCookie ? '' : '; Secure')

  async function lookupByUsername(name) {
    const { rows: [row] } = await pool.query('SELECT id,username,password_hash,enabled FROM accounts WHERE username_key=$1', [normalize(name)])
    return row
  }

  async function lockName(db, username) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [normalize(username)])
  }

  async function assertAvailable(db, name) {
    if (await nameExists(db, name)) throw new ProductError(409, 'That engine name is already provisioned')
  }

  async function nameExists(db, name) {
    const { rowCount } = await db.query(
      'SELECT 1 FROM accounts WHERE username_key=$1 UNION ALL SELECT 1 FROM agent_grants WHERE engine_key=$1 LIMIT 1',
      [normalize(name)],
    )
    return rowCount > 0
  }

  async function provisionHuman(name, password) {
    if (!usernamePattern.test(name) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw new ProductError(400, 'Provide a valid username and a password between 12 and 128 characters')
    }
    const hash = await hashPassword(password)
    return transaction(pool, async db => {
      await lockName(db, name)
      await assertAvailable(db, name)
      const id = randomUUID()
      await db.query('INSERT INTO accounts(id,username,username_key,password_hash) VALUES ($1,$2,$3,$4)', [id, name, normalize(name), hash])
      return id
    })
  }

  async function provisionAgent(owner, engineName, scopes, token = newToken()) {
    if (!usernamePattern.test(engineName) || !digestPattern.test(token)
      || !Array.isArray(scopes) || scopes.length < 1 || scopes.some(scope => !allScopes.includes(scope))) {
      throw new ProductError(400, 'Provide a distinct engine name, token and valid grant scopes')
    }
    return transaction(pool, async db => {
      await lockName(db, engineName)
      await assertAvailable(db, engineName)
      const { rows: [account] } = await db.query('SELECT id FROM accounts WHERE username_key=$1 AND enabled', [normalize(owner)])
      if (!account) throw new ProductError(404, 'Account not found')
      await db.query('INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes) VALUES ($1,$2,$3,$4,$5)',
        [digest(token), account.id, engineName, normalize(engineName), [...new Set(scopes)]])
      return token
    })
  }

  async function revokeAgentDigests(db, digests) {
    if (digests.length) {
      await db.query('UPDATE agent_grants SET revoked_at=now() WHERE digest=ANY($1::text[]) AND revoked_at IS NULL', [digests])
    }
  }

  async function revokeAgent(token) {
    await revokeAgentDigests(pool, [digest(token)])
  }

  async function importProvisionBundle(bundle) {
    const { accounts, agents, revocations } = validateProvisionList(bundle)
    for (const user of accounts) {
      if (!validName(user?.username) || typeof user.passwordHash !== 'string' || !prehashedPasswordPattern.test(user.passwordHash)) {
        throw new ProductError(400, 'Invalid prehashed manual account')
      }
    }
    for (const agent of agents) {
      if (!validName(agent?.owner) || !validName(agent.engineName) || typeof agent.tokenDigest !== 'string'
        || !tokenDigestPattern.test(agent.tokenDigest) || !validScopes(agent.scopes)) {
        throw new ProductError(400, 'Invalid prehashed agent grant')
      }
    }
    const revokedDigests = revocations.map(revocation => {
      if (typeof revocation?.tokenDigest !== 'string' || !tokenDigestPattern.test(revocation.tokenDigest)) {
        throw new ProductError(400, 'Invalid prehashed agent revocation')
      }
      return revocation.tokenDigest
    })
    const names = [...new Set([
      ...accounts.map(user => normalize(user.username)),
      ...agents.flatMap(agent => [normalize(agent.owner), normalize(agent.engineName)]),
    ])].sort()
    return transaction(pool, async db => {
      for (const name of names) await lockName(db, name)
      for (const user of accounts) {
        if (await nameExists(db, user.username)) continue
        await db.query('INSERT INTO accounts(id,username,username_key,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [randomUUID(), user.username, normalize(user.username), user.passwordHash])
      }
      for (const agent of agents) {
        if (await nameExists(db, agent.engineName)) continue
        const { rows: [owner] } = await db.query('SELECT id FROM accounts WHERE username_key=$1 AND enabled', [normalize(agent.owner)])
        if (!owner) throw new ProductError(400, 'Manual agent owner is unavailable')
        await db.query(`INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [
          agent.tokenDigest, owner.id, agent.engineName, normalize(agent.engineName), [...new Set(agent.scopes)],
        ])
      }
      await revokeAgentDigests(db, revokedDigests)
    })
  }

  async function signIn(name, password) {
    if (typeof password !== 'string' || password.length > 128 || typeof name !== 'string' || name.length > 24) return null
    const row = await lookupByUsername(name)
    const verified = await verifyPassword(password, row?.password_hash ?? dummyHash)
    if (!verified || !row?.enabled) return null
    const token = newToken()
    await pool.query('INSERT INTO browser_sessions(digest,account_id,expires_at) VALUES ($1,$2,$3)',
      [digest(token), row.id, new Date(Date.now() + browserDuration)])
    return cookieName + '=' + token + '; Max-Age=' + browserDuration / 1000 + attributes
  }

  function sessionDigest(req) {
    const cookie = req.headers.cookie?.split(';').find(pair => pair.trim().startsWith(cookieName + '='))
    const token = cookie?.trim().slice(cookieName.length + 1)
    return token && digestPattern.test(token) ? digest(token) : null
  }

  async function signOut(req) {
    const session = sessionDigest(req)
    if (session) await pool.query('DELETE FROM browser_sessions WHERE digest=$1', [session])
    return cookieName + '=; Max-Age=0' + attributes
  }

  async function resolve(req) {
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer ([a-z0-9_-]{43})$/i.exec(req.headers.authorization)
      if (!match) return null
      const tokenDigest = digest(match[1])
      const { rows: [row] } = await pool.query(
        'SELECT a.id, a.username, g.engine_name, g.scopes FROM agent_grants g JOIN accounts a ON a.id=g.account_id WHERE g.digest=$1 AND g.revoked_at IS NULL AND a.enabled',
        [tokenDigest],
      )
      return row ? actor(row.id, row.username, row.engine_name, row.scopes, true) : resolveOAuth(tokenDigest)
    }
    const session = sessionDigest(req)
    if (!session) return null
    const { rows: [row] } = await pool.query(
      'SELECT a.id, a.username FROM browser_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.digest=$1 AND s.expires_at>now() AND a.enabled',
      [session],
    )
    return row ? { ...actor(row.id, row.username, row.username, allScopes), browserSession: session } : null
  }

  async function fromEngine(name) {
    if (!name || !usernamePattern.test(name)) return null
    const { rows: [human] } = await pool.query('SELECT id, username FROM accounts WHERE username_key=$1 AND enabled', [normalize(name)])
    if (human) return actor(human.id, human.username, human.username, allScopes)
    const { rows: [agent] } = await pool.query(
      'SELECT a.id,a.username,g.engine_name,g.scopes FROM agent_grants g JOIN accounts a ON a.id=g.account_id WHERE g.engine_key=$1 AND g.revoked_at IS NULL AND a.enabled',
      [normalize(name)],
    )
    return agent ? actor(agent.id, agent.username, agent.engine_name, agent.scopes, true) : null
  }

  return { provisionHuman, provisionAgent, revokeAgent, importProvisionBundle, signIn, signOut, resolve, fromEngine }
}

function actor(accountId, username, engineName, scopes, agent = false) {
  return { accountId, username, engineName, scopes, agent }
}

export function viewerNames(actor) {
  return [...new Set([actor.engineName, actor.username].map(normalize))]
}

export function identityView(actor) {
  const { accountId, engineName, scopes, agent, connectionId } = actor
  return { accountId, engineName, scopes, agent, ...(connectionId ? { connectionId } : {}) }
}
