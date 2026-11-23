import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Pool } from 'pg'

const run = promisify(execFile)
const script = fileURLToPath(new URL('./tournament-admins.mjs', import.meta.url))
const testUrl = process.env.PLAYMAT_TEST_DATABASE_URL

test('the deployment CLI grants only selected human owners in the production schema and preserves other roles', { skip: !testUrl }, async (t) => {
  const name = 'test_admin_bootstrap_' + randomUUID().replaceAll('-', '')
  const base = new Pool({ connectionString: testUrl })
  await base.query('CREATE DATABASE ' + name)
  const url = new URL(testUrl)
  url.pathname = '/' + name
  const db = new Pool({ connectionString: url.href })
  t.after(async () => {
    await db.end()
    await base.query('DROP DATABASE ' + name)
    await base.end()
  })

  await db.query(`CREATE SCHEMA playmat_product;
    CREATE TABLE playmat_product.accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL,
      username_key text NOT NULL UNIQUE, enabled boolean NOT NULL, unlimited_match_history boolean NOT NULL);
    INSERT INTO playmat_product.accounts(username,username_key,enabled,unlimited_match_history) VALUES
      ('copper','copper',true,true),('AmBer','amber',true,false),('Disabled','disabled',false,true),('Existing','existing',true,true);
    CREATE TABLE public.accounts (LIKE playmat_product.accounts INCLUDING ALL);
    INSERT INTO public.accounts(username,username_key,enabled,unlimited_match_history) VALUES
      ('Copper','copper',true,true),('Amber','amber',true,true),('Decoy','decoy',true,true)`)
  const command = (...args) => run(process.execPath, [script, ...args], { env: { DATABASE_URL: url.href } })
  const grant = (...names) => command('grant-existing-owners', ...names)
  async function rejected(args, diagnostics) {
    await assert.rejects(command(...args), error => {
      assert.equal(error.stdout, '')
      assert.deepEqual(error.stderr.trim().split('\n').map(line => JSON.parse(line.replace(/^tournament_admin_error /, ''))), diagnostics)
      return true
    })
  }
  const hasRoleColumn = schema => db.query(`SELECT EXISTS(SELECT FROM information_schema.columns WHERE table_schema=$1
      AND table_name='accounts' AND column_name='tournament_admin') AS present`,[schema]).then(r => r.rows[0].present)
  const result = () => db.query('SELECT username FROM playmat_product.accounts WHERE tournament_admin ORDER BY username').then(r => r.rows.map(row => row.username))
  await rejected(['grant-existing-owners','Copper','Decoy','DISABLED'], [
    { code: 'missing', username: 'Decoy' }, { code: 'disabled', username: 'DISABLED' },
  ])
  await rejected(['grant-existing-owners','Copper','COPPER'], [{ code: 'duplicate', username: 'COPPER' }])
  await rejected(['grant-existing-owners','bad alias'], [{ code: 'invalid_arguments' }])
  const check = await command('check-existing-owners','COPPER','Amber')
  assert.match(check.stdout, /tournament_admin_owner /)
  assert.equal(await hasRoleColumn('playmat_product'),false)
  const owners = (await db.query("SELECT username,id FROM playmat_product.accounts WHERE username_key IN ('copper','amber') ORDER BY username_key")).rows
  await grant('Existing')
  const granted = await grant('Copper','Amber')
  assert.deepEqual(granted.stdout.trim().split('\n').map(line => {
    assert.ok(line.startsWith('tournament_admin_granted '))
    return JSON.parse(line.slice('tournament_admin_granted '.length))
  }), owners)
  assert.deepEqual(await result(), ['AmBer','Existing','copper'])
  assert.equal((await grant('AMBER','copper')).stdout, granted.stdout)
  assert.equal(await hasRoleColumn('public'),false)
  await db.query('ALTER TABLE playmat_product.accounts RENAME TO hidden_accounts')
  await rejected(['check-existing-owners','copper'], [{ code: 'db_error', sqlstate: '42P01' }])
})
