import pg from 'pg'
import { isUuid, ProductError } from './decks.mjs'
import { excludeAsOperator, inspectMatchStatistics } from './match-statistics.mjs'

const [command, matchId, reason, ...extra] = process.argv.slice(2)
if (!isUuid(matchId) || extra.length || !((command === 'inspect' && reason === undefined) || (command === 'exclude' && reason))) {
  console.error('Usage: node match-statistics-cli.mjs inspect MATCH_ID | exclude MATCH_ID "REASON"')
  process.exitCode = 2
} else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=playmat_product', max: 1, connectionTimeoutMillis: 5000 })
  try {
    if (command === 'exclude') await excludeAsOperator(pool, matchId, reason)
    console.log(JSON.stringify(await inspectMatchStatistics(pool, matchId)))
  } catch (error) {
    console.error(error instanceof ProductError ? error.message : 'Could not access match statistics')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
