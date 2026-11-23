import { Pool } from 'pg'
import { normalize, transaction } from './decks.mjs'

class OwnerSelectionError extends Error {
  constructor(issues) {
    super('Owner selection failed')
    this.issues = issues
  }
}

function validate(operation, names) {
  if (!['check-existing-owners', 'grant-existing-owners'].includes(operation) ||
      !names.length || names.some(name => !/^[a-z0-9_-]{3,24}$/i.test(name))) {
    throw new OwnerSelectionError([{ code: 'invalid_arguments' }])
  }
  const seen = new Set()
  for (const username of names) {
    const key = normalize(username)
    if (seen.has(key)) throw new OwnerSelectionError([{ code: 'duplicate', username }])
    seen.add(key)
  }
}

async function resolveOwners(db, names, grant) {
  const { rows } = await db.query(`SELECT username, username_key, id, enabled FROM playmat_product.accounts
    WHERE username_key=ANY($1::text[]) ORDER BY username_key ` + (grant ? 'FOR UPDATE' : ''), [names.map(normalize)])
  const byName = new Map(rows.map(row => [row.username_key, row]))
  const issues = []
  for (const username of names) {
    const row = byName.get(normalize(username))
    if (!row?.enabled) issues.push({ code: row ? 'disabled' : 'missing', username })
  }
  if (issues.length) throw new OwnerSelectionError(issues)
  return rows.map(({ username, id }) => ({ username, id }))
}

const [operation, ...names] = process.argv.slice(2)
let pool
try {
  validate(operation, names)
  if (!process.env.DATABASE_URL) throw new Error('Missing database connection')
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
  const grant = operation === 'grant-existing-owners'
  const owners = await transaction(pool, async db => {
    if (!grant) await db.query('SET TRANSACTION READ ONLY')
    await db.query("SET LOCAL lock_timeout = '5s'")
    // Pre-deploy can precede the new application's startup migrations.
    if (grant) await db.query('ALTER TABLE playmat_product.accounts ADD COLUMN IF NOT EXISTS tournament_admin boolean NOT NULL DEFAULT false')
    const owners = await resolveOwners(db, names, grant)
    if (grant) await db.query('UPDATE playmat_product.accounts SET tournament_admin=true WHERE id=ANY($1::uuid[]) AND NOT tournament_admin', [
      owners.map(owner => owner.id),
    ])
    return owners
  })
  const prefix = grant ? 'tournament_admin_granted ' : 'tournament_admin_owner '
  for (const owner of owners) console.log(prefix + JSON.stringify(owner))
} catch (error) {
  const issues = error instanceof OwnerSelectionError ? error.issues : [{
    code: 'db_error',
    ...(/^[0-9A-Z]{5}$/.test(error.code ?? '') && { sqlstate: error.code }),
  }]
  for (const issue of issues) console.error('tournament_admin_error ' + JSON.stringify(issue))
  process.exitCode = 1
} finally {
  await pool?.end()
}
