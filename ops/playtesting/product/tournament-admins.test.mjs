import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Pool } from 'pg'

const run = promisify(execFile)
const script = fileURLToPath(new URL('./tournament-admins.mjs', import.meta.url))
const databaseUrl = process.env.PLAYMAT_TEST_DATABASE_URL

test('pre-deploy grants only explicitly verified existing owners, atomically and additively', { skip: !databaseUrl }, async (t) => {
  const schema = 'test_admin_bootstrap_' + randomUUID().replaceAll('-', '')
  const base = new Pool({ connectionString: databaseUrl })
  await base.query('CREATE SCHEMA ' + schema)
  const options = '-c search_path=' + schema
  const db = new Pool({ connectionString: databaseUrl, options })
  t.after(async () => {
    await db.end()
    await base.query('DROP SCHEMA ' + schema + ' CASCADE')
    await base.end()
  })
  await db.query(`CREATE TABLE accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text UNIQUE NOT NULL,
    enabled boolean NOT NULL, unlimited_match_history boolean NOT NULL);
    INSERT INTO accounts(username,enabled,unlimited_match_history) VALUES
      ('Copper',true,true),('Amber',true,true),('Limited',true,false),('Disabled',false,true),('Existing',true,true)`)
  const command = (...args) => run(process.execPath, [script, ...args], {
    env: { DATABASE_URL: databaseUrl, PGOPTIONS: options },
  })
  const grant = (...names) => command('grant-existing-history-owners', ...names)
  const result = () => db.query('SELECT username FROM accounts WHERE tournament_admin ORDER BY username').then(r => r.rows.map(row => row.username))
  for (const names of [[], ['Copper','Missing'], ['Copper','Limited'], ['Copper','Disabled'], ['copper'], ['Copper','Copper'], ['Copper','--all']]) {
    await assert.rejects(grant(...names), error => error.code !== 0 && error.stdout === '' && !error.stderr.includes('postgresql:'))
  }
  await assert.rejects(command('grant', 'Copper'))
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND column_name='tournament_admin'`,[schema])).rows[0].n, 0)
  await grant('Existing')
  const created = await grant('Copper','Amber')
  const owners = (await db.query("SELECT username,id FROM accounts WHERE username IN ('Copper','Amber') ORDER BY username")).rows
  assert.deepEqual(created.stdout.trim().split('\n').map(line => {
    assert.ok(line.startsWith('tournament_admin_granted '))
    return JSON.parse(line.slice('tournament_admin_granted '.length))
  }), owners)
  assert.deepEqual(await result(), ['Amber','Copper','Existing'])
  assert.equal((await grant('Amber','Copper')).stdout, created.stdout)
  assert.deepEqual(await result(), ['Amber','Copper','Existing'])
})
