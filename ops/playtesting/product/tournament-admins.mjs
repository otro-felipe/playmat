import { Pool } from 'pg'
import { transaction } from './decks.mjs'

const [operation, ...names] = process.argv.slice(2)
const validNames = names.length > 0 && names.every(name => /^[a-z0-9_-]{3,24}$/i.test(name))
if (operation !== 'grant-existing-history-owners' || !validNames || new Set(names).size !== names.length) {
  console.error('Usage: tournament-admins.mjs grant-existing-history-owners EXACT_USERNAME [EXACT_USERNAME ...]')
  process.exitCode = 2
} else if (!process.env.DATABASE_URL) {
  console.error('A product database connection is required')
  process.exitCode = 1
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const owners = await transaction(pool, async db => {
      await db.query("SET LOCAL lock_timeout = '5s'")
      // Pre-deploy runs before the new application has installed its startup migrations.
      await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tournament_admin boolean NOT NULL DEFAULT false')
      const { rows } = await db.query(`SELECT username,id FROM accounts
        WHERE username=ANY($1::text[]) AND enabled AND unlimited_match_history
        ORDER BY username FOR UPDATE`, [names])
      if (rows.length !== names.length) throw new Error('Ineligible owner')
      await db.query('UPDATE accounts SET tournament_admin=true WHERE id=ANY($1::uuid[]) AND NOT tournament_admin', [
        rows.map(owner => owner.id),
      ])
      return rows
    })
    for (const owner of owners) console.log('tournament_admin_granted ' + JSON.stringify(owner))
  } catch {
    console.error('Tournament administrator bootstrap failed. Verify the exact enabled history owners and database access.')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
