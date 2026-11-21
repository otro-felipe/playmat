import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const databaseUrl = process.env.PLAYMAT_TEST_DATABASE_URL
const password = 'synthetic-fixture-credential'

test('MCP decks have a reusable opponent shelf; only the owner moves legacy decks without losing revisions', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const owner = await signIn(f, 'LibraryOwner')
  const other = await signIn(f, 'OtherOwner')
  const agent = { Authorization: 'Bearer ' + await f.product.provisionAgent('LibraryOwner', 'LibraryMcp', ['library']) }
  const noLibrary = { Authorization: 'Bearer ' + await f.product.provisionAgent('LibraryOwner', 'PlayOnly', ['play']) }
  const root = '/api/playtesting/decks'
  assert.deepEqual((await (await f.path(root, { headers: owner })).json()).decks, [])
  const ownId = 'library', agentId = randomUUID()
  const data = { name: 'Reusable deck', format: 'Pioneer', library: 'agent', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] }
  const put = (id, headers, expectedRevision = 0) => f.path(`${root}/${id}`, json('PUT', headers, { expectedRevision, data }))
  const personal = await (await put(ownId, owner)).json()
  const rival = await (await put(agentId, agent)).json()
  assert.equal(personal.library, 'personal', 'a browser cannot spoof the MCP shelf through metadata')
  assert.equal(rival.library, 'agent')
  assert.equal((await (await put(ownId, agent, 1)).json()).library, 'personal', 'editing does not reclassify existing decks')
  const listed = await (await f.path(root + '?library=agent', { headers: agent })).json()
  assert.deepEqual(listed.decks.map(deck => deck.id), [agentId])
  assert.equal((await f.path(root + '?library=invalid', { headers: owner })).status, 400)
  assert.equal((await f.path(root, { headers: noLibrary })).status, 403)
  assert.equal((await f.path(`${root}/${agentId}`, { headers: other })).status, 404)
  const move = (headers, revision, library = 'agent') => f.path(`${root}/${ownId}/library`, json('POST', headers, { expectedRevision: revision, library }))
  assert.equal((await move(agent, 2)).status, 403)
  assert.equal((await move(other, 2)).status, 409)
  assert.equal((await move(owner, 1)).status, 409)
  assert.equal((await move(owner, 2, 'unknown')).status, 400)
  const moved = await (await move(owner, 2)).json()
  assert.equal(moved.id, ownId)
  assert.equal(moved.revision, 2)
  assert.equal(moved.library, 'agent')
  assert.deepEqual(moved.data.cards, personal.data.cards)
  const firstRevision = await (await f.path(`${root}/${ownId}?revision=1`, { headers: owner })).json()
  assert.equal(firstRevision.revision, 1)
  assert.deepEqual(firstRevision.data.cards, personal.data.cards)
  assert.equal((await (await move(owner, 2, 'personal')).json()).library, 'personal')
})

async function fixture(t, store = new Map(), options = {}) {
  const { createProduct } = await import('./product.mjs')
  const replayDirectory = await mkdtemp(join(tmpdir(), 'playmat-replays-'))
  const schema = `test_${randomUUID().replaceAll('-', '')}`
  const product = await createProduct({ databaseUrl, schema, replayDirectory, store, insecureCookie: true, enableInternal: true, ...options })
  const server = product.server
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.close()
    await product.dropTestSchema()
    await product.close()
    await rm(replayDirectory, { recursive: true, force: true })
  })
  const endpoint = `http://127.0.0.1:${server.address().port}`
  return { product, replayDirectory, schema, endpoint, path: (route, init) => fetch(endpoint + route, init) }
}

test('limits public socket upgrades by visitor and leaves authenticated pages available', { skip: !databaseUrl }, async t => {
  const f = await fixture(t, new Map(), { publicUrl: 'https://playmat.example' })
  const owner = await signIn(f, 'SocketBudget')
  const source = '198.51.100.5'
  const socket = '/internal/verify?scope=play'
  const headers = { ...owner, 'X-Playmat-Client-IP': source, Origin: 'https://playmat.example' }
  const rejected = await f.path(socket, { headers: { ...headers, Origin: 'https://other.example' } })
  assert.equal(rejected.status, 403)
  for (let i = 0; i < 35; i++) assert.equal((await f.path(socket, { headers })).status, 200)
  const throttled = await f.path(socket, { headers })
  assert.equal(throttled.status, 429)
  assert.match(throttled.headers.get('retry-after'), /^\d+$/)
  assert.equal((await f.path(socket, { headers: { ...headers, 'X-Playmat-Client-IP': '198.51.100.6' } })).status, 200)
  assert.equal((await f.path('/api/playtesting/me', { headers })).status, 200)
})

async function signIn(f, name) {
  await f.product.provisionHuman(name, password)
  const response = await f.path('/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: name, password }),
  })
  assert.equal(response.status, 303)
  return { Cookie: response.headers.get('set-cookie').split(';')[0] }
}

function json(method, headers, body) {
  return { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function withTestDatabase(f, run) {
  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: databaseUrl, options: '-c search_path=' + f.schema })
  await db.connect()
  try {
    return await run(db)
  } finally {
    await db.end()
  }
}

const reviewPrivacy = '/api/playtesting/review/privacy';

async function archivedReviewMatch(f, { id = randomUUID(), tableId = randomUUID(), status = 'completed', players }) {
  const gameId = randomUUID();
  await withTestDatabase(f, async db => {
    await db.query('INSERT INTO matches(id,table_id,name,started_at,ended_at,status) VALUES($1,$2,$3,$4,$5,$6)',
      [id, tableId, 'Synthetic privacy fixture', Date.now() - 1000, status === 'completed' ? Date.now() : null, status]);
    await db.query("INSERT INTO games(id,match_id,game_number,started_at,status,archive_state) VALUES($1,$2,1,$3,'completed','ready')",
      [gameId, id, Date.now() - 1000]);
    for (const { engineName, human } of players) {
      await db.query('INSERT INTO game_players(game_id,engine_key,engine_name,human) VALUES($1,lower($2),$2,$3)',
        [gameId, engineName, human]);
    }
  });
  return { id, tableId, gameId };
}

test('[PM-REVIEW-PRIV-1] protected recording starts automatically for the actual account seats', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const host = await signIn(f, 'ReviewHost')
  const guest = await signIn(f, 'ReviewGuest')
  const outsider = await signIn(f, 'ReviewStranger')
  const token = await f.product.provisionAgent('ReviewGuest', 'ReviewRival', ['play','history'])
  const agent = { Authorization: 'Bearer ' + token }
  const seats = [{ engineName: 'ReviewHost', playerId: randomUUID(), human: true },
    { engineName: 'ReviewRival', playerId: randomUUID(), human: true }]
  const tableId = randomUUID(), matchId = randomUUID()
  const seal = (table, id, players = seats) => f.path('/internal/review-capture',
    json('POST', {}, { tableId: table, matchId: id, seats: players }))

  assert.deepEqual(await (await seal(tableId, matchId)).json(), { reviewVersion: 2 })
  assert.deepEqual(await (await seal(tableId, matchId, [...seats].reverse())).json(), { reviewVersion: 2 })
  assert.deepEqual(await (await seal(tableId, randomUUID())).json(), { reviewVersion: null })
  assert.deepEqual(await (await seal(tableId, matchId, seats.map((seat, i) =>
    i ? { ...seat, engineName: 'AnotherPlayer' } : seat))).json(), { reviewVersion: null })
  assert.deepEqual(await (await seal(randomUUID(), randomUUID(), seats.map((seat, i) =>
    i ? { ...seat, engineName: 'AnotherPlayer' } : seat))).json(), { reviewVersion: null })

  const { id } = await archivedReviewMatch(f, { id: matchId, tableId, players: seats })
  const route = `${reviewPrivacy}/matches/${id}`
  for (const headers of [host, agent]) {
    const response = await f.path(route, { headers })
    assert.equal(response.status, 200)
    const access = await response.json()
    assert.equal(access.fullAvailable, true)
    assert.equal(access.viewerSeatId, headers === host ? 'reviewhost' : 'reviewrival')
  }
  const noHistory = { Authorization: 'Bearer ' + await f.product.provisionAgent('ReviewHost', 'ReviewPlayOnly', ['play']) }
  assert.equal((await f.path(route, { headers: noHistory })).status, 403)
  assert.equal((await f.path(route, { headers: guest })).status, 404, 'Browser replay follows the same engine-seat scope as History')
  assert.equal((await f.path(route, { headers: outsider })).status, 404)
  assert.equal((await f.path(route)).status, 401)
  // A pre-existing capture without typed events keeps its sealed ownership and can show its archived hands.
  await withTestDatabase(f, db => db.query('UPDATE replay_review_captures SET review_version=NULL WHERE match_id=$1', [matchId]))
  assert.equal((await (await f.path(route, { headers: host })).json()).fullAvailable, true)
  assert.equal((await f.path(route, json('PUT', host, { version: 2 }))).status, 405)
  assert.equal((await f.path(`${reviewPrivacy}/tables/${tableId}`, json('PUT', host, { version: 2 }))).status, 404)
})

test('[PM-REVIEW-PRIV-2/3/4] completed legacy captures open automatically to identified participants', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const host = await signIn(f, 'LegacyOwner')
  const guest = await signIn(f, 'LegacyOpponent')
  const outsider = await signIn(f, 'LegacyOutsider')
  const token = await f.product.provisionAgent('LegacyOwner', 'LegacyAgent', ['history'])
  const agent = { Authorization: 'Bearer ' + token }
  const { id } = await archivedReviewMatch(f, { status: 'active',
    players: [{ engineName: 'LegacyOwner', human: true }, { engineName: 'LegacyOpponent', human: true }] })
  const route = `${reviewPrivacy}/matches/${id}`
  const settings = headers => f.path(route, { headers })
  assert.equal((await settings(outsider)).status, 404)
  assert.equal((await (await settings(host)).json()).fullAvailable, false)
  await withTestDatabase(f, db => db.query("UPDATE matches SET status='completed',ended_at=started_at+3000 WHERE id=$1", [id]))
  for (const headers of [host, guest, agent]) assert.equal((await (await settings(headers)).json()).fullAvailable, true)
  assert.equal((await settings(outsider)).status, 404)
  const view = await (await settings(agent)).json()
  assert.equal(view.viewerSeatId, 'legacyowner')
  assert.deepEqual(view.perspectives.map(({ seatId, owned }) => [seatId, owned]),
    [['legacyopponent', false], ['legacyowner', true]])
  const unresolved = await archivedReviewMatch(f, {
    players: [{ engineName: 'LegacyOwner', human: true }, { engineName: 'UnidentifiedSeat', human: true }],
  })
  const restricted = await (await f.path(`${reviewPrivacy}/matches/${unresolved.id}`, { headers: host })).json()
  assert.equal(restricted.fullAvailable, false)
  assert.equal(restricted.reason, 'participant_authority_missing')
})

test('recovery binds immutable account and grant IDs and rechecks grant revocation without trusting names', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'RecoveryOwner')
  const other = await signIn(f, 'RecoveryOther')
  const token = await f.product.provisionAgent('RecoveryOwner', 'RecoveryAgent', ['play'])
  const human = await f.path('/internal/verify?scope=play', { headers: alice })
  const accountId = human.headers.get('X-Playmat-Account')
  const seatId = human.headers.get('X-Playmat-Seat')
  assert.equal(seatId, 'human:' + accountId)
  const agent = await f.path('/internal/verify?scope=play', { headers: { Authorization: 'Bearer ' + token } })
  const grant = { accountId, seatId: agent.headers.get('X-Playmat-Seat') }
  assert.match(grant.seatId, /^agent:[a-f0-9-]{36}$/)
  const validate = principal => f.path('/internal/recovery/validate', json('POST', {}, principal))
  assert.equal((await validate(grant)).status, 200)
  const otherId = (await f.path('/internal/verify', { headers: other })).headers.get('X-Playmat-Account')
  assert.equal((await validate({ ...grant, accountId: otherId })).status, 403)
  assert.equal((await validate({ accountId, seatId: 'agent:' + randomUUID(), engineName: 'RecoveryAgent' })).status, 403)
  await f.product.revokeAgent(token)
  assert.equal((await validate(grant)).status, 403)
  await withTestDatabase(f, db => db.query('UPDATE accounts SET enabled=false WHERE id=$1', [accountId]))
  assert.equal((await validate({ accountId, seatId })).status, 403)
})

test('recovery revalidates the current OAuth connection independently of its durable grant identity', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const cookie = await signIn(f, 'RecoveryOAuth')
  await f.product.provisionAgent('RecoveryOAuth', 'RecoveryOA', ['play'])
  const accountId = (await f.path('/internal/verify', { headers: cookie })).headers.get('X-Playmat-Account')
  const connectionId = randomUUID()
  const seatId = await withTestDatabase(f, async db => {
    const { rows: [grant] } = await db.query("UPDATE agent_grants SET oauth_managed=true WHERE engine_key='recoveryoa' RETURNING recovery_id")
    await db.query("INSERT INTO oauth_connections(id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at) VALUES($1,$2,'recoveryoa','fixture-client','fixture-resource',ARRAY['play'],$3,now()+interval '1 hour')", [connectionId, accountId, randomUUID()])
    return 'agent:' + grant.recovery_id
  })
  const validate = principal => f.path('/internal/recovery/validate', json('POST', {}, principal))
  assert.equal((await validate({ accountId, seatId })).status, 403)
  assert.equal((await validate({ accountId, seatId, connectionId })).status, 200)
  await withTestDatabase(f, db => db.query('UPDATE oauth_connections SET revoked_at=now() WHERE id=$1', [connectionId]))
  assert.equal((await validate({ accountId, seatId, connectionId })).status, 403)
})

test('[PM-AC-04] password sign-in and scoped forward auth reject forged or revoked identities', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  assert.equal((await f.path('/internal/verify', { headers: { 'X-Playmat-User': 'Alice' } })).status, 401)
  assert.equal((await f.path('/register', json('POST', {}, { username: 'guest', password }))).status, 404)
  const alice = await signIn(f, 'Alice')
  const verified = await f.path('/internal/verify', { headers: { ...alice, 'X-Playmat-User': 'Mallory' } })
  assert.equal(verified.headers.get('X-Playmat-User'), 'Alice')
  const grant = await f.product.provisionAgent('Alice', 'AgentAlice', ['play','library','history'])
  const agent = { Authorization: `Bearer ${grant}` }
  const identity = await (await f.path('/internal/verify', { headers: agent })).json()
  assert.equal(identity.engineName, 'AgentAlice')
  assert.notEqual(identity.engineName, 'Alice')
  await f.product.revokeAgent(grant)
  assert.equal((await f.path('/internal/verify', { headers: agent })).status, 401)
  assert.equal((await f.path('/logout', { method: 'POST', headers: alice, redirect: 'manual' })).status, 303)
  assert.equal((await f.path('/internal/verify', { headers: alice })).status, 401)
})

test('[PM-AC-04] the claimed guest and actual table host control admission', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const carol = await signIn(f, 'Carol')
  const tableId = randomUUID()
  const roomId = randomUUID()
  const route = '/api/playtesting/invites'
  const invite = await f.path(route, json('POST', alice, {
    tableId, roomId, guestEngineName: 'Bob', format: 'Pioneer', password,
  }))
  assert.equal(invite.status, 201)
  const friendInvitation = await invite.json()
  assert.equal(Object.hasOwn(friendInvitation, 'password'), false)
  assert.equal(Object.hasOwn(friendInvitation, 'chatMode'), false)
  assert.equal((await f.path(route, json('POST', alice, {
    tableId: randomUUID(), roomId, guestEngineName: 'Bob', format: 'Pioneer', password, chatMode: 'coach',
  }))).status, 400)
  assert.deepEqual((await (await f.path(route, { headers: alice })).json()).invites, [])
  assert.deepEqual((await (await f.path(route, { headers: carol })).json()).invites, [])
  assert.deepEqual((await (await f.path(route + '?limit=1', { headers: bob })).json()).invites.map(row => row.tableId), [tableId])
  const claim = route + '/' + tableId + '/claim'
  const gate = '/internal/invites/' + tableId + '?host=Alice&guest=Bob'
  assert.equal((await f.path(gate)).status, 404)
  assert.equal((await f.path(claim, { method: 'POST', headers: carol })).status, 404)
  const accepted = await Promise.all([1, 2].map(() => f.path(claim, { method: 'POST', headers: bob })))
  assert.deepEqual(accepted.map(response => response.status), [200, 200])
  assert.deepEqual(await accepted[0].json(), await accepted[1].json())
  assert.equal((await f.path(gate)).status, 200)
  assert.equal((await f.path(gate.replace('=Alice', '=Carol'))).status, 404)
})

test('[PM-SETUP-AC-03] an unlisted link is undiscoverable and reserves a single human guest seat', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const host = await signIn(f, 'UnlistedHost')
  const guests = ['LinkGuestA', 'LinkGuestB']
  const browsers = await Promise.all(guests.map(name => signIn(f, name)))
  const delegated = { Authorization: 'Bearer ' + await f.product.provisionAgent('LinkGuestA', 'LinkAgent', ['play']) }
  const tableId = randomUUID()
  const route = '/api/playtesting/invites'
  const invite = route + '/' + tableId
  const gate = (guest, mode = '') => f.path(`/internal/invites/${tableId}?host=UnlistedHost&guest=${guest}${mode}`)
  const created = await f.path(route, json('POST', host, {
    tableId, roomId: randomUUID(), mode: 'friend', format: 'Pioneer', password,
  }))
  assert.equal(created.status, 201)
  assert.equal((await created.json()).unlisted, true)
  assert.equal((await f.path(invite)).status, 401)
  assert.equal((await f.path(invite, { headers: delegated })).status, 404)
  assert.equal((await f.path(invite + '/claim', { method: 'POST', headers: delegated })).status, 404)
  for (const [index, headers] of browsers.entries()) {
    const name = guests[index]
    assert.deepEqual((await (await f.path(route, { headers })).json()).invites, [])
    assert.deepEqual(await (await f.path('/internal/invites?guest=' + name)).json(), [])
    const view = await (await f.path(invite, { headers })).json()
    assert.equal(view.guestEngineName, null)
    assert.equal(Object.hasOwn(view, 'password'), false)
    assert.equal((await gate(name)).status, 404)
    assert.equal((await gate(name, '&lookup=link')).status, 200)
  }
  assert.equal((await gate('LinkAgent', '&lookup=link')).status, 404)
  const claim = headers => f.path(invite + '/claim', { method: 'POST', headers })
  const answers = await Promise.all(browsers.map(claim))
  assert.deepEqual(answers.map(response => response.status).sort(), [200, 404])
  const winningIndex = answers.findIndex(response => response.status === 200)
  const winner = guests[winningIndex], other = guests[1 - winningIndex]
  assert.equal((await answers[winningIndex].json()).password, password)
  assert.equal((await claim(browsers[winningIndex])).status, 200)
  assert.equal((await gate(winner)).status, 200)
  assert.equal((await gate(other)).status, 404)
  assert.equal((await gate(other, '&lookup=link')).status, 404)
  assert.deepEqual(await (await f.path('/internal/invites?guest=' + winner)).json(), [])
  await withTestDatabase(f, db => db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE table_id=$1", [tableId]))
  assert.equal((await gate(winner, '&lookup=link')).status, 404)
  assert.equal((await claim(browsers[winningIndex])).status, 404)
})

test('[PM-AC-04] an existing legacy MCP link admits exactly one delegated identity with a display-only alias', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const host = await signIn(f, 'Host')
  const guest = await signIn(f, 'Guest')
  const engineNames = ['HostAgent', 'GuestAgent']
  const tokens = await Promise.all([
    f.product.provisionAgent('Host', engineNames[0], ['play']),
    f.product.provisionAgent('Guest', engineNames[1], ['play']),
  ])
  const grants = tokens.map(token => ({ Authorization: `Bearer ${token}` }))
  const restricted = { Authorization: `Bearer ${await f.product.provisionAgent('Guest', 'LibraryAgent', ['library'])}` }
  const tableId = randomUUID()
  const invitations = '/api/playtesting/invites'
  const invitation = `${invitations}/${tableId}`
  const createLegacy = async options => {
    const response = await f.path(invitations, json('POST', host, options))
    assert.equal(response.status, 201)
    await withTestDatabase(f, db => db.query('UPDATE invitations SET owner_account_id=NULL WHERE table_id=$1', [options.tableId]))
    return response
  }
  const created = await createLegacy({
    tableId, roomId: randomUUID(), format: 'Pioneer', password, mode: 'mcp', chatMode: 'coach',
  })
  assert.equal(created.status, 201)
  const createdInfo = await created.json()
  assert.equal(createdInfo.mode, 'mcp')
  assert.equal(createdInfo.chatMode, 'coach')
  assert.equal(createdInfo.guestEngineName, null)
  assert.equal(Object.hasOwn(createdInfo, 'password'), false)
  assert.deepEqual((await (await f.path(invitations, { headers: grants[0] })).json()).invites, [])
  assert.equal((await f.path(invitation, { headers: guest })).status, 404)
  assert.equal((await f.path(invitation + '/claim', json('POST', guest, {}))).status, 404)
  assert.equal((await f.path(invitation + '/claim', json('POST', restricted, {}))).status, 403)
  assert.equal((await f.path(invitation, { headers: grants[0] })).status, 200)
  assert.equal((await f.path(`${invitations}/${randomUUID()}`, { headers: grants[0] })).status, 404)

  const claim = headers => f.path(invitation + '/claim', json('POST', headers, { displayName: 'The Angel' }))
  assert.equal((await f.path(invitation + '/claim', json('POST', grants[0], { displayName: '<script>' }))).status, 400)
  const responses = await Promise.all(grants.map(claim))
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 404])
  const winner = responses.findIndex(response => response.status === 200)
  const claimed = await responses[winner].json()
  assert.equal(claimed.guestEngineName, engineNames[winner])
  assert.equal(claimed.guestDisplayName, 'The Angel')
  assert.equal(claimed.chatMode, 'coach')
  const repeated = await f.path(invitation + '/claim', json('POST', grants[winner], { displayName: 'Different alias', chatMode: 'chatty' }))
  assert.equal(repeated.status, 200)
  const repeatedInfo = await repeated.json()
  assert.equal(repeatedInfo.guestDisplayName, 'The Angel')
  assert.equal(repeatedInfo.chatMode, 'coach')
  assert.equal((await claim(grants[1 - winner])).status, 404)
  const shownToHost = await (await f.path(invitation, { headers: host })).json()
  assert.equal(shownToHost.guestDisplayName, 'The Angel')
  assert.equal(shownToHost.chatMode, 'coach')
  assert.equal(Object.hasOwn(shownToHost, 'password'), false)
  const gate = `/internal/invites/${tableId}?host=Host&guest=`
  assert.equal((await f.path(gate + engineNames[winner])).status, 200)
  assert.equal((await f.path(gate + encodeURIComponent('The Angel'))).status, 404)
  assert.equal((await f.path(gate + engineNames[1 - winner])).status, 404)
  assert.equal((await f.path('/api/playtesting/decks', { headers: grants[winner] })).status, 403)

  const ownSeat = randomUUID()
  await createLegacy({
    tableId: ownSeat, roomId: randomUUID(), format: 'Pioneer', password, mode: 'mcp',
  })
  const selfDelegation = await f.path(`${invitations}/${ownSeat}/claim`, json('POST', grants[0], {}))
  assert.equal(selfDelegation.status, 200)
  const ownSeatInfo = await selfDelegation.json()
  assert.equal(ownSeatInfo.guestEngineName, engineNames[0])
  assert.equal(ownSeatInfo.chatMode, 'quiet')
  assert.equal((await f.path(`/internal/invites/${ownSeat}?host=Host&guest=HostAgent`)).status, 200)

  for (const [chatMode, status] of [['chatty', 201], ['quiet', 201], ['invalid', 400], [null, 400]]) {
    const response = await f.path(invitations, json('POST', host, {
      tableId: randomUUID(), roomId: randomUUID(), format: 'Pioneer', password, mode: 'mcp', chatMode,
    }))
    assert.equal(response.status, status)
    if (status === 201) assert.equal((await response.json()).chatMode, chatMode)
  }

  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: databaseUrl, options: `-c search_path=${f.schema}` })
  await db.connect()
  try {
    await db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE table_id=$1", [tableId])
  } finally {
    await db.end()
  }
  assert.equal((await claim(grants[winner])).status, 404)
  assert.equal((await f.path(gate + engineNames[winner])).status, 404)
  await f.product.revokeAgent(tokens[0])
  assert.equal((await f.path(`/internal/invites/${ownSeat}?host=Host&guest=HostAgent`)).status, 404)
})

test('[PM-AC-16] an MCP table belongs to the signed-in account and notifies only its own connected agent', { skip: !databaseUrl }, async t => {
  const issuer = 'https://playmat-invitations.example'
  const f = await fixture(t, new Map(), {
    publicUrl: issuer,
    eventOptions: { deliver: async (_url, { body }) => {
      const { challenge } = JSON.parse(body)
      assert.ok(challenge)
      return { status: 200, body: JSON.stringify({ challenge }) }
    } },
  })
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const legacy = { Authorization: 'Bearer ' + await f.product.provisionAgent('Alice', 'LegacyAgent', ['play']) }
  const route = '/api/playtesting/invites'
  const tableId = randomUUID()
  const invite = { tableId, roomId: randomUUID(), format: 'Pioneer', password, mode: 'mcp' }
  const link = route + '/' + tableId

  const created = await f.path(route, json('POST', alice, invite))
  assert.equal(created.status, 201, 'the game can be created before connecting a client')
  assert.equal((await created.json()).guestEngineName, null)
  assert.equal((await f.path(link, { headers: legacy })).status, 404)

  const { digest, newToken } = await import('./identity.mjs')
  const oauth = (username, engineName) => withTestDatabase(f, async db => {
    const { rows: [{ id: accountId }] } = await db.query('SELECT id FROM accounts WHERE username=$1', [username])
    const connection = randomUUID()
    const access = newToken()
    await db.query(`INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes,oauth_managed)
      VALUES($1,$2,$3,$4,ARRAY['play','chat','library'],true)`, [digest(newToken()), accountId, engineName, engineName])
    await db.query(`INSERT INTO oauth_connections(id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at)
      VALUES($1,$2,$3,'https://chatgpt.com/oauth/client.json',$4,ARRAY['play','chat','library'],$5,now()+interval '1 day')`,
    [connection, accountId, engineName, issuer + '/mcp', digest(newToken())])
    await db.query(`INSERT INTO oauth_access_tokens(digest,connection_id,expires_at)
      VALUES($1,$2,now()+interval '1 hour')`, [digest(access), connection])
    return { Authorization: 'Bearer ' + access }
  })
  const engineName = 'mcp_00000000000000000001'
  const owner = await oauth('Alice', engineName)
  const other = await oauth('Bob', 'mcp_00000000000000000002')

  const params = {
    name: 'game.invitation.created',
    delivery: { mode: 'webhook', url: 'https://receiver.example.net/mcp-events', secret: 'whsec_' + Buffer.alloc(32, 19).toString('base64') },
  }
  for (const headers of [owner, other, legacy]) {
    assert.equal((await f.path('/internal/mcp-events/subscribe', json('POST', headers, params))).status, 200)
  }
  assert.deepEqual((await (await f.path(route, { headers: owner })).json()).invites.map(row => row.tableId), [tableId])
  for (const headers of [bob, legacy, other]) {
    assert.deepEqual((await (await f.path(route, { headers })).json()).invites, [])
    assert.equal((await f.path(link, { headers })).status, 404)
    assert.equal((await f.path(link + '/claim', json('POST', headers, {}))).status, 404)
  }
  assert.equal((await f.path(link + '/claim', json('POST', alice, {}))).status, 404)
  assert.equal((await f.path(link, { headers: alice })).status, 200)
  assert.equal((await f.path(link, { headers: owner })).status, 200)

  const gate = '/internal/invites/' + tableId + '?host=Alice&guest=' + engineName
  assert.equal((await f.path(gate)).status, 404)
  const accepted = await f.path(link + '/claim', json('POST', owner, { displayName: 'Desk rival' }))
  assert.equal(accepted.status, 200)
  const acceptedInfo = await accepted.json()
  assert.equal(acceptedInfo.guestDisplayName, 'Desk rival')
  assert.equal(acceptedInfo.guestEngineName, engineName)
  assert.equal((await f.path(gate)).status, 200)

  const notifiedId = randomUUID()
  const notified = await f.path(route, json('POST', alice, { ...invite, tableId: notifiedId }))
  assert.equal(notified.status, 201)
  assert.equal((await notified.json()).guestEngineName, null, 'notification alone leaves the rival seat empty')
  assert.equal((await f.path(route, json('POST', alice, { ...invite, tableId: notifiedId }))).status, 409)
  const queue = await withTestDatabase(f, async db => (await db.query(`SELECT e.event_name, e.engine_key, e.table_id, e.format
    FROM mcp_events e JOIN mcp_event_deliveries d ON d.event_id=e.id`)).rows)
  assert.deepEqual(queue, [{
    event_name: 'game.invitation.created', engine_key: engineName, table_id: notifiedId, format: 'Pioneer',
  }])

  const fallback = await f.path(route + '/' + notifiedId + '/claim', json('POST', owner, {}))
  assert.equal(fallback.status, 200)
  assert.equal((await fallback.json()).guestDisplayName, 'Rival MCP')
})

test('[PM-AC-04] a prehashed provisioning import is idempotent and cannot rotate an existing identity', { skip: !databaseUrl }, async t => {
  const { newToken, prepareProvisionBundle } = await import('./identity.mjs')
  const f = await fixture(t)
  const grant = newToken()
  const replacement = newToken()
  const first = await prepareProvisionBundle({
    accounts: [{ username: 'Alice', password }],
    agents: [{ owner: 'Alice', engineName: 'AgentAlice', token: grant, scopes: ['play'] }],
  })
  assert.doesNotMatch(JSON.stringify(first), new RegExp(password + '|' + grant))
  await f.product.importProvisionBundle(first)
  await f.product.importProvisionBundle(first)
  await f.product.importProvisionBundle(await prepareProvisionBundle({
    accounts: [{ username: 'alice', password: 'different-synthetic-password' }],
    agents: [{ owner: 'Alice', engineName: 'agentalice', token: replacement, scopes: ['play', 'history'] }],
  }))
  const response = await f.path('/login', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'Alice', password }),
  })
  assert.equal(response.status, 303)
  const initial = await f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + grant } })
  assert.deepEqual((await initial.json()).scopes, ['play'])
  assert.equal((await f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + replacement } })).status, 401)
})

test('[PM-AC-04] provisioning revokes only the targeted grant and preserves independently scoped replacements', { skip: !databaseUrl }, async t => {
  const { digest, newToken, prepareProvisionBundle } = await import('./identity.mjs')
  const f = await fixture(t)
  await f.product.provisionHuman('Alice', password)
  const original = await f.product.provisionAgent('Alice', 'AgentAlice', ['play', 'library', 'history', 'chat'])
  const rival = newToken()
  const analyst = newToken()
  const verify = token => f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + token } })
  const provision = await prepareProvisionBundle({
    agents: [
      { owner: 'Alice', engineName: 'AliceRival', token: rival, scopes: ['play', 'chat'] },
      { owner: 'Alice', engineName: 'AliceLab', token: analyst, scopes: ['library', 'history'] },
    ],
    revocations: [{ token: original }],
  })
  assert.equal((await verify(original)).status, 200)
  await f.product.importProvisionBundle(provision)
  assert.equal((await verify(original)).status, 401)
  assert.deepEqual(provision.revocations, [{ tokenDigest: digest(original) }])
  assert.doesNotMatch(JSON.stringify(provision), new RegExp(original))
  await f.product.importProvisionBundle(provision)
  await f.product.importProvisionBundle({ revocations: [{ tokenDigest: digest(newToken()) }] })
  await f.product.importProvisionBundle(await prepareProvisionBundle({
    agents: [{ owner: 'Alice', engineName: 'agentalice', token: original, scopes: ['play'] }],
  }))
  assert.equal((await verify(original)).status, 401)
  assert.deepEqual((await (await verify(rival)).json()).scopes, ['play', 'chat'])
  assert.deepEqual((await (await verify(analyst)).json()).scopes, ['library', 'history'])
  await assert.rejects(prepareProvisionBundle({ revocations: [{ token: 'invalid' }] }), { status: 400 })
  await assert.rejects(f.product.importProvisionBundle({
    revocations: [{ tokenDigest: digest(rival) }, { tokenDigest: 'invalid' }],
  }), { status: 400 })
  assert.equal((await verify(rival)).status, 200)
})

test('[PM-AC-05] browser and delegated agent share immutable owned revisions and reject stale writes', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const token = await f.product.provisionAgent('Alice', 'AgentAlice', ['library'])
  const agent = { Authorization: `Bearer ${token}` }
  const deckId = randomUUID()
  const route = `/api/playtesting/decks/${deckId}`
  const deck = { name: 'Mono Red', format: 'Pioneer', cards: [{ name: 'Mountain', set: 'DMU', number: '280', quantity: 60 }], sideboard: [] }
  assert.equal((await f.path(route, json('PUT', alice, { expectedRevision: 0, data: deck }))).status, 200)
  assert.equal((await f.path(route, { headers: bob })).status, 404)
  assert.equal((await (await f.path(route, { headers: agent })).json()).revision, 1)
  const results = await Promise.all([alice, agent].map((headers, i) => f.path(route, json('PUT', headers, {
    expectedRevision: 1, data: { ...deck, name: `Version ${i}` },
  }))))
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409])
  const saved = await (await f.path(route, { headers: alice })).json()
  assert.equal(saved.revision, 2)
  assert.equal((await f.path(route + '?revision=1', { headers: agent })).status, 200)
  assert.equal((await (await f.path(route + '?revision=1', { headers: agent })).json()).data.name, 'Mono Red')
})

test('[PM-AC-05] the account library saves browser drafts and preserves their chosen engine formats', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = { ...await signIn(f, 'Alice'), 'X-Playmat-Deck-Owner': 'Alice' }
  const bob = { ...await signIn(f, 'Bob'), 'X-Playmat-Deck-Owner': 'Bob' }
  const library = '/api/playtesting/decks'
  const deck = { name: 'New deck', cards: [], sideboard: [] }
  const formats = [
    [undefined, 'Constructed - Freeform'],
    [' ', 'Constructed - Freeform'],
    ['Freeform', 'Constructed - Freeform'],
    ['Constructed - Freeform', 'Constructed - Freeform'],
    ['Variant Magic - Commander', 'Variant Magic - Commander'],
    ['Block Constructed Custom - Star Wars', 'Block Constructed Custom - Star Wars'],
    ['Constructed Custom - Custom fixture', 'Constructed Custom - Custom fixture'],
    ['Constructed - Pioneer', 'Pioneer'],
  ]
  for (const [format, storedFormat] of formats) {
    const route = `${library}/${randomUUID()}`
    const saved = await f.path(route, json('PUT', alice, { expectedRevision: 0, data: { ...deck, format } }))
    assert.equal(saved.status, 200, `The library accepts ${format ?? 'a missing format'}`)
    const { revision, data } = await saved.json()
    assert.equal(revision, 1)
    assert.deepEqual([data.format, data.cards, data.sideboard], [storedFormat, [], []])
    assert.equal((await f.path(route, { headers: bob })).status, 404)

    const edited = { expectedRevision: revision, data: { ...data, name: 'Edited draft' } }
    assert.equal((await f.path(route, json('PUT', alice, edited))).status, 200)
    assert.equal((await f.path(route, json('PUT', alice, edited))).status, 409)
    const history = await (await f.path(route + '?revision=1', { headers: alice })).json()
    assert.deepEqual([history.revision, history.data.format, history.data.name], [1, storedFormat, 'New deck'])
  }
  for (const format of ['Constructed - ' + 'x'.repeat(120), 'Constructed - Bad\nFormat', 'constructor', 42]) {
    assert.equal((await f.path(`${library}/${randomUUID()}`, json('PUT', alice, {
      expectedRevision: 0, data: { ...deck, format },
    }))).status, 400)
  }
  const rejectedInvite = await f.path('/api/playtesting/invites', json('POST', alice, {
    tableId: randomUUID(), roomId: randomUUID(), format: 'Constructed - Freeform', mode: 'mcp', password,
  }))
  assert.equal(rejectedInvite.status, 400)
})

test('[PM-AC-05] startup upgrades existing deck storage without changing its saved decks', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const owner = await signIn(f, 'Alice')
  const route = `/api/playtesting/decks/${randomUUID()}`
  const deck = { name: 'Existing list', format: 'Pioneer', cards: [], sideboard: [] }
  assert.equal((await f.path(route, json('PUT', owner, { expectedRevision: 0, data: deck }))).status, 200)
  await withTestDatabase(f, db => db.query(`ALTER TABLE deck_revisions
    DROP CONSTRAINT IF EXISTS deck_revisions_library_format_check,
    DROP CONSTRAINT IF EXISTS deck_revisions_format_check,
    ADD CONSTRAINT deck_revisions_format_check CHECK (format IN ('Standard', 'Pioneer', 'Modern'))`))
  await withTestDatabase(f, db => db.query('ALTER TABLE decks DROP COLUMN library'))

  const { createProduct } = await import('./product.mjs')
  const reopened = await createProduct({ databaseUrl, schema: f.schema, replayDirectory: f.replayDirectory, store: new Map() })
  await reopened.close()

  const saved = await f.path(route, json('PUT', owner, { expectedRevision: 1, data: { ...deck, format: 'Constructed - Freeform' } }))
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).revision, 2)
  const previous = await (await f.path(route + '?revision=1', { headers: owner })).json()
  assert.deepEqual([previous.revision, previous.data.name, previous.data.format], [1, 'Existing list', 'Pioneer'])
  assert.equal(previous.data.library, 'personal')
})

async function addReplay(f, matchId, gameId, names, events, now = Date.now()) {
  const info = {
    gameId, matchId, tableId: matchId, startedAt: now - 1000, endedAt: now,
    result: 'Game finished', winner: names[0], turns: 4, events: 2, deckType: 'Constructed - Pioneer',
    players: names.map(name => ({ name, human: true, deck: { cards: [`private:${name}`] } })),
  }
  await writeFile(join(f.replayDirectory, gameId + '.json'), JSON.stringify(info))
  const data = events ?? [
    { t: 100, view: { turn: 1, players: names.map(name => ({ name })) }, hands: Object.fromEntries(names.map(name => [name, [`secret:${name}`]])) },
    { t: 105, log: { messageType: 'TALK', message: 'private chat' } },
  ]
  await writeFile(join(f.replayDirectory, gameId + '.ndjson.gz'), gzipSync(data.map(row => JSON.stringify(row)).join('\n')))
}

async function historyMatch(f, names, time, { active = false, gameCount = 1 } = {}) {
  const id = randomUUID()
  const games = Array.from({ length: gameCount }, () => randomUUID())
  for (const game of games) await addReplay(f, id, game, names, undefined, time)
  if (!active) await writeFile(join(f.replayDirectory, id + '.match.json'), JSON.stringify({ matchId: id, endedAt: time }))
  return { id, games }
}

test('[PM-AC-21] history retains twenty completed matches per account across its seats and blocks old direct reads', { skip: !databaseUrl }, async t => {
  const objects = new Map()
  const f = await fixture(t, objects)
  const regular = await signIn(f, 'Regular')
  const exempt = await signIn(f, 'Exempt')
  const token = await f.product.provisionAgent('Regular', 'RegularAgent', ['history'])
  const agent = { Authorization: 'Bearer ' + token }
  await assert.rejects(f.product.setUnlimitedMatchHistory(['Exempt', 'Missing'], true), { status: 404 })
  await f.product.setUnlimitedMatchHistory(['EXEMPT'], true)

  const started = Date.now() - 10000
  const root = '/api/playtesting/'
  const oldest = await historyMatch(f, ['Regular', 'Exempt'], started)
  await f.product.archiveGames()
  const exportHandle = await f.path(root + 'exports', json('POST', regular, { gameIds: oldest.games, mode: 'handle' }))
  assert.equal(exportHandle.status, 201)
  const { path: exportPath } = await exportHandle.json()

  const retained = []
  for (let index = 0; index < 20; index += 1) {
    const seat = index === 0 ? 'RegularAgent' : 'Regular'
    retained.push(await historyMatch(f, [seat, 'Exempt'], started + index + 1,
      { gameCount: index === 0 ? 2 : 1 }))
  }
  const active = await historyMatch(f, ['Regular', 'Exempt'], started - 2, { active: true })
  await f.product.archiveGames()

  const list = async (headers, query = '') => {
    const response = await f.path(root + 'matches' + query, { headers })
    assert.equal(response.status, 200)
    return response.json()
  }
  const { matches } = await list(agent)
  assert.deepEqual(matches.map(match => match.id), [...retained].reverse().map(match => match.id).concat(active.id))
  assert.equal(matches.at(-2).games.length, 2, 'sideboard games occupy one history slot')
  assert.equal(matches.at(-1).status, 'active')
  assert.equal((await list(regular)).matches.length, 20, 'the browser has its established seat scope')
  assert.equal((await list(exempt)).matches.length, 22)
  const firstPage = await list(agent, '?format=Pioneer&limit=5')
  const secondPage = await list(agent, '?format=Pioneer&cursor=' + firstPage.cursor)
  assert.deepEqual(secondPage.matches.map(match => match.id), matches.slice(5).map(match => match.id))
  await withTestDatabase(f, db => db.query("UPDATE matches SET format='Modern' WHERE id=$1", [retained.at(-1).id]))
  assert.deepEqual((await list(agent, '?format=Pioneer')).matches.map(match => match.id), matches.slice(1).map(match => match.id))
  const stats = async headers => (await (await f.path(root + 'stats', { headers })).json()).groups
  assert.equal((await stats(agent)).reduce((total, group) => total + group.games, 0), 21)
  assert.equal((await stats(exempt)).reduce((total, group) => total + group.games, 0), 22)

  const [game] = oldest.games
  for (const path of ['matches/' + oldest.id, 'replays/' + game, 'evaluations/' + game,
    'review/games/' + game, 'review/matches/' + oldest.id, 'review/privacy/matches/' + oldest.id]) {
    assert.equal((await f.path(root + path, { headers: regular })).status, 404, path)
  }
  assert.equal((await f.path(exportPath, { headers: regular })).status, 404)
  assert.equal((await f.path(root + 'exports', json('POST', agent, { gameIds: [game] }))).status, 404)
  assert.equal((await f.path(root + 'replays/' + game, { headers: exempt })).status, 200)
  assert.equal(objects.size, 23, 'access retention leaves stored replay objects available for the exempt participant')
  await f.product.setUnlimitedMatchHistory(['Exempt'], false)
  assert.equal((await list(exempt)).matches.length, 21)
})

test('a personal history reset hides closed matches across owned seats, preserves shared replays and counts new matches', { skip: !databaseUrl }, async t => {
  const f = await fixture(t, new Map(), { purgeExpiredHistory: true })
  const felipe = await signIn(f, 'Felipe')
  const rival = await signIn(f, 'OtherPlayer')
  const agent = { Authorization: 'Bearer ' + await f.product.provisionAgent('Felipe', 'Pilot', ['history']) }
  await f.product.setUnlimitedMatchHistory(['Felipe'], true)
  const cutoff = Date.now() - 5000
  const shared = await historyMatch(f, ['Felipe', 'OtherPlayer'], cutoff - 1000)
  const solo = await historyMatch(f, ['Pilot', 'Guest'], cutoff - 500)
  const live = await historyMatch(f, ['Felipe', 'OtherPlayer'], cutoff - 50, { active: true })
  const later = await historyMatch(f, ['Felipe', 'OtherPlayer'], cutoff + 2000)
  await f.product.archiveGames()
  const root = '/api/playtesting/'
  const list = async headers => (await (await f.path(root + 'matches', { headers })).json()).matches.map(m => m.id)
  const counts = await f.product.resetMatchHistory('fELiPe', cutoff)
  assert.deepEqual(counts, { hidden: 2, remainingClosed: 1 })
  assert.deepEqual(await list(felipe), [later.id, live.id])
  assert.deepEqual(await list(agent), [later.id, live.id])
  assert.deepEqual(await list(rival), [later.id, live.id, shared.id])
  const stats = await (await f.path(root + 'stats', { headers: felipe })).json()
  assert.equal(stats.groups.reduce((n, g) => n + g.games, 0), 1)
  for (const path of ['matches/' + shared.id, 'replays/' + shared.games[0], 'review/matches/' + shared.id]) {
    assert.equal((await f.path(root + path, { headers: felipe })).status, 404)
  }
  assert.equal((await f.path(root + 'replays/' + shared.games[0], { headers: rival })).status, 200)
  await f.product.archiveGames({ maintainHistory: true })
  await withTestDatabase(f, async db => {
    assert.equal((await db.query('SELECT id FROM matches WHERE id=$1', [solo.id])).rowCount, 1)
    assert.equal((await db.query('SELECT unlimited_match_history FROM accounts WHERE username_key=$1', ['felipe'])).rows[0].unlimited_match_history, true)
  })
  assert.deepEqual(await f.product.resetMatchHistory('Felipe', cutoff), { hidden: 0, remainingClosed: 1 })
  await assert.rejects(f.product.resetMatchHistory('Unknown', cutoff), { status: 404 })
  await assert.rejects(f.product.resetMatchHistory('Felipe', Date.now() + 60000), { status: 400 })
})

test('[PM-AC-21] opt-in purge removes only unretained closed matches and retries replay deletion safely', { skip: !databaseUrl }, async t => {
  const objects = new Map()
  const deletionAttempts = []
  let deleteUnavailable = true
  const f = await fixture(t, {
    async put(key, body) { objects.set(key, body) },
    async get(key) { return objects.get(key) },
    async delete(key) {
      deletionAttempts.push(key)
      if (deleteUnavailable) throw Error('synthetic deletion outage')
      objects.delete(key)
    },
  }, { purgeExpiredHistory: true })
  await signIn(f, 'Regular')
  const exempt = await signIn(f, 'Exempt')
  await f.product.setUnlimitedMatchHistory(['Exempt'], true)

  const started = Date.now() - 10000
  const expired = await historyMatch(f, ['Regular', 'Guest'], started - 2)
  const active = await historyMatch(f, ['Regular', 'Guest'], started - 1, { active: true })
  const shared = await historyMatch(f, ['Regular', 'Exempt'], started)
  for (let index = 0; index < 20; index += 1) await historyMatch(f, ['Regular', 'Guest'], started + index + 1)
  await f.product.archiveGames({ maintainHistory: true })
  await withTestDatabase(f, async db => {
    assert.deepEqual((await db.query('SELECT id FROM matches WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[expired.id, active.id, shared.id]])).rows.map(row => row.id).sort(), [active.id, shared.id].sort())
    assert.equal((await db.query('SELECT count(*)::int AS n FROM replay_object_deletions')).rows[0].n, 1)
    await db.query('UPDATE replay_object_deletions SET available_at=now()')
  })
  await f.product.archiveGames({ maintainHistory: true })
  assert.equal(deletionAttempts.length, 1)
  assert.ok(objects.has(deletionAttempts[0]))
  deleteUnavailable = false
  await withTestDatabase(f, db => db.query('UPDATE replay_object_deletions SET available_at=now()'))
  await addReplay(f, expired.id, expired.games[0], ['Regular', 'Guest'], undefined, started - 2)
  await writeFile(join(f.replayDirectory, expired.id + '.match.json'), JSON.stringify({ matchId: expired.id, endedAt: started }))
  await f.product.archiveGames({ maintainHistory: true })
  assert.equal(deletionAttempts.length, 2)
  assert.equal(objects.has(deletionAttempts[0]), false)
  assert.equal((await f.path('/api/playtesting/replays/' + shared.games[0], { headers: exempt })).status, 200)
  await withTestDatabase(f, async db => {
    assert.equal((await db.query('SELECT id FROM matches WHERE id=$1', [expired.id])).rowCount, 0)
    assert.equal((await db.query('SELECT * FROM replay_object_deletions')).rowCount, 0)
  })
  await assert.rejects(readFile(join(f.replayDirectory, expired.games[0] + '.json')), { code: 'ENOENT' })
})

async function addSideboardReplay(f, matchId, gameId, number, decks) {
  const names = ['Alice', 'Bob']
  await addReplay(f, matchId, gameId, names)
  const filename = join(f.replayDirectory, gameId + '.json')
  const info = JSON.parse(await readFile(filename, 'utf8'))
  info.gameNumber = number
  info.players.forEach((player, index) => { player.deck = decks[index] })
  await writeFile(filename, JSON.stringify(info))
}

test('[PM-REVIEW-API-6] completed adjacent snapshots reveal only the viewing seat changes despite full hand permission', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const outsider = await signIn(f, 'Carol')
  const matchId = randomUUID()
  const first = randomUUID(), second = randomUUID()
  const card = (cardName, setCode = 'M21') => ({ cardName, setCode, cardNumber: '001' })
  await addSideboardReplay(f, matchId, first, 1, [
    { name: 'Private Alice list before', cards: [card('Island'), card('Opt'), card('Opt')], sideboard: [card('Negate'), card('Negate')] },
    { name: 'Private Bob list before', cards: [card('Mountain'), card('Lightning Strike')], sideboard: [card('Shock')] },
  ])
  await addSideboardReplay(f, matchId, second, 2, [
    { name: 'Private Alice list after', cards: [card('Island', 'DOM'), card('Negate'), card('Negate')], sideboard: [card('Opt'), card('Opt')] },
    { name: 'Private Bob list after', cards: [card('Mountain'), card('Shock')], sideboard: [card('Lightning Strike')] },
  ])
  await writeFile(join(f.replayDirectory, matchId + '.match.json'), JSON.stringify({ matchId, endedAt: Date.now() }))
  await f.product.archiveGames()
  const root = '/api/playtesting/review'
  const own = async (id, headers) => (await f.path(root + '/games/' + id, { headers })).json()
  const firstGame = await own(first, alice)
  assert.deepEqual(firstGame.sideboardDelta, { status: 'initial_game' })
  const current = await own(second, alice)
  assert.equal(current.fullAvailable, true)
  assert.deepEqual(current.sideboardDelta, {
    status: 'available', fromGameNumber: 1, toGameNumber: 2,
    broughtIn: [{ name: 'Negate', amount: 2 }], tookOut: [{ name: 'Opt', amount: 2 }],
  })
  assert.doesNotMatch(JSON.stringify(current), /Private .* list|Lightning Strike|Shock|Mountain|Island/)
  const peer = await own(second, bob)
  assert.deepEqual(peer.sideboardDelta.broughtIn, [{ name: 'Shock', amount: 1 }])
  assert.deepEqual(peer.sideboardDelta.tookOut, [{ name: 'Lightning Strike', amount: 1 }])
  const encounter = await (await f.path(root + '/matches/' + matchId, { headers: alice })).json()
  assert.deepEqual(encounter.games[1].sideboardDelta, current.sideboardDelta)
  assert.equal((await f.path(root + '/games/' + second, { headers: outsider })).status, 404)
})

test('[PM-REVIEW-API-6] active or incomplete adjacent lists do not become inferred sideboard moves', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const matchId = randomUUID()
  const first = randomUUID(), second = randomUUID(), third = randomUUID(), gap = randomUUID()
  const changedPool = randomUUID(), unchanged = randomUUID()
  const before = { cards: [{ cardName: 'Forest' }], sideboard: [{ cardName: 'Mountain' }] }
  const after = { cards: [{ cardName: 'Mountain' }], sideboard: [{ cardName: 'Forest' }] }
  await addSideboardReplay(f, matchId, first, 1, [before, before])
  await addSideboardReplay(f, matchId, second, 2, [after, after])
  await addSideboardReplay(f, matchId, third, 3, [{ cards: after.cards }, after])
  await addSideboardReplay(f, matchId, gap, 5, [before, before])
  const different = { cards: [{ cardName: 'Island' }], sideboard: [] }
  await addSideboardReplay(f, matchId, changedPool, 6, [different, different])
  await addSideboardReplay(f, matchId, unchanged, 7, [different, different])
  await f.product.archiveGames()
  const own = async id => (await (await f.path('/api/playtesting/review/games/' + id, { headers: alice })).json()).sideboardDelta
  assert.deepEqual(await own(second), { status: 'unavailable' })
  await writeFile(join(f.replayDirectory, matchId + '.match.json'), JSON.stringify({ matchId, endedAt: Date.now() }))
  await f.product.archiveGames()
  assert.equal((await own(second)).status, 'available')
  assert.deepEqual(await own(third), { status: 'unavailable' })
  assert.deepEqual(await own(gap), { status: 'unavailable' })
  assert.deepEqual(await own(changedPool), { status: 'unavailable' })
  assert.deepEqual(await own(unchanged), {
    status: 'available', fromGameNumber: 6, toGameNumber: 7, broughtIn: [], tookOut: [],
  })
  await withTestDatabase(f, db => db.query("UPDATE games SET status='interrupted' WHERE id=$1", [first]))
  assert.deepEqual(await own(second), { status: 'unavailable' })
})

async function analysisFixture(t, { completed = true, fresh = false, rollback = false, missedOpportunity = false,
  transition = false, targetedDiscard = false, coalesced = false } = {}) {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const outsider = await signIn(f, 'Carol')
  const matchId = randomUUID()
  const gameId = randomUUID()
  const aliceId = randomUUID()
  const bobId = randomUUID()
  const opportunityObjectId = randomUUID()
  const discardSourceId = randomUUID()
  const discardedCardId = randomUUID()
  const logRef = (id, name) => `<font color='#fff' object_id='${id}'>${name}</font> [${id.slice(0, 3)}]`
  const lobby = { turn: 2, step: 'PRECOMBAT_MAIN', activePlayerName: 'Alice', priorityPlayerName: 'Alice',
    players: [{ name: 'Alice', playerId: aliceId }, { name: 'Bob', playerId: bobId }] }
  const hand = { Alice: { forest: { name: 'Forest', cardTypes: ['LAND'] },
    ...(missedOpportunity ? { [opportunityObjectId]: { id: opportunityObjectId, name: 'Opt' } } : {}) },
    Bob: { obscured: { name: 'Rival hand sentinel' } } }
  const opening = { t: 10, view: lobby, hands: hand,
    ...(fresh ? { review: { seatViews: {
      [aliceId]: { myHand: hand.Alice, lookedAt: { own: { name: 'Alice known-only sentinel' } } },
      [bobId]: { myHand: hand.Bob, lookedAt: { own: { name: 'Bob known-only sentinel' } } },
    } } } : {}),
  }
  await addReplay(f, matchId, gameId, ['Alice', 'Bob'], [
    opening,
    { t: 11, log: { messageType: 'GAME', message: 'Alice plays Forest', unrelated: 'Unknown log field sentinel' } },
    ...(coalesced ? [{ t: 11, log: { messageType: 'GAME', message: 'Alice casts Opt [abc] targeting Bob from hand' } }] : []),
    { t: 12, view: lobby, hands: { ...hand, Alice: { future: { name: 'Later visibility sentinel' } } } },
    { t: 13, kind: 'draw', actorPlayerId: bobId, turn: 2, step: 'DRAW', card: { id: randomUUID(), name: 'Exact draw sentinel' } },
    { t: 15, log: { messageType: 'GAME', message: 'Bob passes priority' } },
    ...(rollback ? [{ t: 16, kind: 'rollback', turn: 2 }, { ...opening, t: 17 },
      { t: 18, log: { messageType: 'GAME', message: 'Alice activates a retained ability' } }] : []),
    ...(missedOpportunity ? [
      { ...opening, t: 19, view: { ...lobby, priorityPlayerName: transition ? 'Bob' : 'Alice' } },
      ...(transition ? [{ t: 20, log: { messageType: 'GAME', message: 'Alice plays Island' } }] : []),
      { ...opening, t: 21, view: { ...lobby, priorityPlayerName: 'Bob', step: transition ? 'BEGIN_COMBAT' : lobby.step } },
    ] : []),
    ...(targetedDiscard ? [
      { t: 22, log: { messageType: 'GAME', message: `Alice casts ${logRef(discardSourceId, 'Thoughtseize')} targeting Bob from hand` } },
      { t: 23, log: { messageType: 'GAME', message: `Bob discards ${logRef(discardedCardId, 'Go for the Throat')} (source: ${logRef(discardSourceId, 'Thoughtseize')})` } },
    ] : []),
  ])
  if (fresh) {
    const capture = await f.path('/internal/review-capture', json('POST', {}, { matchId, tableId: matchId, seats: [
      { engineName: 'Alice', playerId: aliceId, human: true }, { engineName: 'Bob', playerId: bobId, human: true },
    ] }))
    assert.equal((await capture.json()).reviewVersion, 2)
    const { readFile } = await import('node:fs/promises')
    const file = join(f.replayDirectory, gameId + '.json')
    const info = JSON.parse(await readFile(file, 'utf8'))
    info.reviewVersion = 2
    info.deckType = 'Constructed - Pauper'
    info.players.forEach((player, index) => { player.playerId = [aliceId, bobId][index] })
    await writeFile(file, JSON.stringify(info))
  }
  if (completed) await writeFile(join(f.replayDirectory, matchId + '.match.json'), JSON.stringify({ matchId, endedAt: Date.now() }))
  await f.product.archiveGames()
  const root = '/api/playtesting/review'
  return { ...f, alice, bob, outsider, matchId, gameId, aliceId, bobId, opportunityObjectId, root, replay: `${root}/games/${gameId}` }
}

test('[PM-REVIEW-API-9] inferred omissions require a witnessed opportunity and remain distinguishable from engine actions', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t, { missedOpportunity: true })
  const { archiveRevision } = await (await f.path(f.replay, { headers: f.alice })).json()
  const entry = {
    cursor: 5, seatId: 'alice', assessment: 'small_loss', confidence: 'high',
    omission: { observedThroughCursor: 6, opportunityObjectId: f.opportunityObjectId },
    rationale: 'Priority moved to Bob while the caster could use their cantrip.', benefit: 'Saves mana.',
    risk: 'Loses the opportunity to select the next draw.',
    alternatives: [{ line: 'Cast Opt with the visible mana source.', legality: 'confirmed', benefit: 'Improve the draw.', risk: 'Spend mana.' }],
  }
  const put = value => f.path(f.replay + '/annotations', json('POST', f.alice, { archiveRevision, entries: [value] }))
  assert.equal((await put({ ...entry, seatId: 'bob' })).status, 400)
  assert.equal((await put({ ...entry, omission: { ...entry.omission, opportunityObjectId: randomUUID() } })).status, 400)
  assert.equal((await put({ ...entry, omission: { ...entry.omission, observedThroughCursor: 2 } })).status, 400)
  const saved = await put(entry)
  assert.equal(saved.status, 200)
  const [annotation] = (await saved.json()).annotations
  assert.equal(annotation.category, 'inaccuracy')
  assert.equal(annotation.confidence, 'medium')
  assert.equal(annotation.evidence.basis, 'inferred_omission')
  const history = await (await f.path(f.replay + '/evidence?purpose=analysis&scope=public&includeBefore=false', { headers: f.alice })).json()
  const marker = history.events.find(event => event.cursor === entry.cursor)
  assert.equal(marker.actual.kind, 'omission')
  assert.equal(marker.evidence.observedThroughCursor, 6)
  assert.doesNotMatch(JSON.stringify(history), /Opt/)
  assert.equal(JSON.stringify(history).includes(f.opportunityObjectId), false)
})

test('[PM-REVIEW-API-9] a committed precombat action and combat frame can witness a missed window despite coalesced priority', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t, { missedOpportunity: true, transition: true })
  const { archiveRevision } = await (await f.path(f.replay, { headers: f.alice })).json()
  const entry = {
    cursor: 7, seatId: 'alice', assessment: 'small_loss', confidence: 'medium',
    omission: { openingCursor: 6, observedThroughCursor: 7, opportunityObjectId: f.opportunityObjectId, window: 'before_combat' },
    rationale: 'Moving to combat used the opportunity to cast a precombat spell.', benefit: 'Keeps resources open.',
    risk: 'Reduces the opportunity to affect attacks.',
    alternatives: [{ line: 'Cast the selected spell before combat.', legality: 'confirmed', benefit: 'Changes the attack.', risk: 'Spends mana.' }],
  }
  const put = value => f.path(f.replay + '/annotations', json('POST', f.alice, { archiveRevision, entries: [value] }))
  assert.equal((await put({ ...entry, omission: { ...entry.omission, window: 'before_end_turn' } })).status, 400)
  const accepted = await put(entry)
  assert.equal(accepted.status, 200)
  const [annotation] = (await accepted.json()).annotations
  assert.equal(annotation.evidence.window, 'before_combat')
  assert.equal(annotation.evidence.openingCursor, 6)
  const playback = await (await f.path(f.replay + '/evidence?purpose=replay&scope=public', { headers: f.alice })).json()
  const closure = playback.events.find(event => event.cursor === 7)
  assert.equal(closure.type, 'frame')
  assert.equal(closure.inferredDecision.actual.kind, 'omission')
  assert.equal(closure.view.step, 'BEGIN_COMBAT')
})

test('[PM-REVIEW-CAPTURE-4] legacy saved discard notes keep revisions and can be read and edited by the witnessed chooser', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t, { targetedDiscard: true })
  const { archiveRevision } = await (await f.path(f.replay, { headers: f.alice })).json()
  const entry = {
    cursor: 6, seatId: 'bob', assessment: 'sound', confidence: 'medium',
    rationale: 'The choice took away the recorded removal spell.', benefit: 'Protects a future threat.', risk: 'Leaves another threat.',
    alternatives: [{ line: 'Take the other legally revealed threat.', legality: 'confirmed', benefit: 'Reduces pressure.', risk: 'Leaves removal.' }],
  }
  const path = f.replay + '/annotations'
  const put = value => f.path(path, json('POST', f.alice, { archiveRevision, entries: [value] }))
  const original = await put(entry)
  assert.equal(original.status, 200)
  const [note] = (await original.json()).annotations
  const read = await (await f.path(path + '?seatId=alice', { headers: f.alice })).json()
  assert.equal(read.annotations[0].decisionSeatId, 'alice')
  assert.equal(read.annotations[0].revision, note.revision)
  const affected = await (await f.path(path + '?seatId=bob', { headers: f.alice })).json()
  assert.deepEqual(affected.annotations, [])
  const edited = await put({ ...entry, seatId: 'alice', expectedRevision: note.revision })
  assert.equal(edited.status, 200)
  const [updated] = (await edited.json()).annotations
  assert.equal(updated.seatId, 'bob')
  assert.equal(updated.decisionSeatId, 'alice')
  assert.equal(updated.cursor, note.cursor)
  assert.equal(updated.category, 'good')
  const manifest = await (await f.path(f.replay, { headers: f.alice })).json()
  assert.equal(manifest.analysis.bySeat.find(seat => seat.seatId === 'alice').reviewed, 1)
  assert.equal(manifest.analysis.bySeat.find(seat => seat.seatId === 'bob').reviewed, 0)
})

test('[PM-REVIEW-API-10] a witnessed decision can earn a medium grade in a coalesced frame', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t, { coalesced: true })
  const { archiveRevision } = await (await f.path(f.replay, { headers: f.alice })).json()
  const entry = {
    cursor: 2, seatId: 'alice', assessment: 'optimal', confidence: 'high',
    rationale: 'The announced timing avoids leaving unused mana.', benefit: 'Improves card selection.', risk: 'Uses mana before combat.',
    alternatives: [{ line: 'Keep mana available.', legality: 'confirmed', benefit: 'Represents interaction.', risk: 'May waste a draw step.' }],
  }
  const put = value => f.path(f.replay + '/annotations', json('POST', f.alice, { archiveRevision, entries: [value] }))
  const original = (await (await put(entry)).json()).annotations[0]
  assert.equal(original.category, 'insufficient')
  const decisionEvidence = { observationCursor: 2, summary: 'The engine log records the cast during the main phase.' }
  const edited = { ...entry, expectedRevision: original.revision, decisionEvidence }
  assert.equal((await put({ ...edited, decisionEvidence: { ...decisionEvidence, observationCursor: 3 } })).status, 400)
  assert.equal((await put({ ...edited, assessment: 'exceptional' })).status, 400)
  assert.equal((await put({ ...edited, alternatives: [] })).status, 400)
  const response = await put(edited)
  assert.equal(response.status, 200)
  const [review] = (await response.json()).annotations
  assert.equal(review.category, 'best')
  assert.equal(review.confidence, 'medium')
  assert.equal(review.evidence.frameQuality, 'coalesced_snapshot')
  assert.equal(review.evidence.observationCursor, 2)
  const oldClientResponse = await put({ ...entry, expectedRevision: review.revision })
  assert.equal(oldClientResponse.status, 200)
  const [oldClientReview] = (await oldClientResponse.json()).annotations
  assert.equal(oldClientReview.category, 'best')
  assert.equal(oldClientReview.evidence.observationCursor, 2)
})

test('[PM-REVIEW-API-1] completed replay manifests preserve legacy authorization and refuse foreign IDs', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t)
  assert.equal((await f.path(f.replay, { headers: f.outsider })).status, 404)
  assert.equal((await f.path(`${f.root}/matches/${f.matchId}`, { headers: f.outsider })).status, 404)
  const response = await f.path(f.replay, { headers: f.alice })
  assert.equal(response.status, 200)
  const manifest = await response.json()
  assert.equal(manifest.matchId, f.matchId)
  assert.equal(manifest.viewerSeatId, 'alice')
  assert.equal(manifest.fullAvailable, true)
  const shared = await f.path(f.replay + '/evidence?scope=full', { headers: f.alice })
  assert.equal(shared.status, 200)
  assert.match(await shared.text(), /Rival hand sentinel/)
  const alternate = await f.path(f.replay + '/evidence?scope=seat&seatId=bob', { headers: f.alice })
  assert.equal(alternate.status, 200)
  assert.match(await alternate.text(), /Rival hand sentinel/)
  const legacy = await f.path('/api/playtesting/replays/' + f.gameId, { headers: f.alice })
  const legacyText = await legacy.text()
  assert.match(legacyText, /Forest/)
  assert.doesNotMatch(legacyText, /Rival hand sentinel/)
})

test('[PM-REVIEW-API-1] a game archived between Bo3 games cannot be analyzed or expose an alternate seat', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t, { completed: false, fresh: true })
  const response = await f.path(f.replay, { headers: f.alice })
  assert.equal(response.status, 200)
  const manifest = await response.json()
  assert.equal(manifest.fullAvailable, false)
  assert.equal(manifest.reason, 'match_active')
  for (const headers of [f.alice, f.bob]) {
    for (const route of ['/evidence?purpose=analysis', '/evidence?scope=full', '/evidence?scope=seat&seatId=bob', '/annotations']) {
      assert.equal((await f.path(f.replay + route, { headers })).status, 409)
    }
    const legacy = await f.path('/api/playtesting/replays/' + f.gameId, { headers })
    assert.equal(legacy.status, 200)
    const page = await legacy.json()
    assert.ok(page.events.every(event => !Object.hasOwn(event, 'hands')))
    const expectedHand = headers === f.alice ? { forest: { name: 'Forest', cardTypes: ['LAND'] } }
      : { obscured: { name: 'Rival hand sentinel' } }
    assert.deepEqual(page.events[0].myHand, expectedHand)
    assert.doesNotMatch(JSON.stringify(page), /known-only sentinel|Exact draw sentinel/)
    if (headers === f.alice) assert.doesNotMatch(JSON.stringify(page), /Rival hand sentinel/)
    else assert.doesNotMatch(JSON.stringify(page), /Later visibility sentinel/)
  }
  assert.equal((await f.path(f.replay + '/evidence?scope=full', { headers: f.outsider })).status, 404)
  assert.equal((await f.path(f.replay + '/annotations', json('POST', f.alice, { entries: [] }))).status, 409)
})

test('[PM-REVIEW-API-2] exact archive cursors survive views and pre-action evidence excludes later information', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t)
  const seatResponse = await f.path(f.replay + '/evidence?count=1', { headers: f.alice })
  assert.equal(seatResponse.status, 200)
  const seat = await seatResponse.json()
  assert.equal(seat.next, 1)
  assert.equal(seat.events[0].cursor, 0)
  assert.match(JSON.stringify(seat.events[0]), /Forest/)
  const publicPage = await (await f.path(f.replay + '/evidence?scope=public&count=2', { headers: f.alice })).json()
  assert.equal(publicPage.events[0].cursor, seat.events[0].cursor)
  assert.doesNotMatch(JSON.stringify(publicPage.events[0]), /Forest|Rival hand sentinel/)
  assert.doesNotMatch(JSON.stringify(publicPage), /Unknown log field sentinel/)
  const analysis = await f.path(f.replay + '/evidence?purpose=analysis&turn=2', { headers: f.alice })
  assert.equal(analysis.status, 200)
  const evidence = await analysis.json()
  const action = evidence.events.find(row => row.cursor === 1)
  assert.equal(action.frameCursor, 0)
  assert.equal(action.seatId, 'alice')
  assert.match(JSON.stringify(action.before), /Forest/)
  assert.doesNotMatch(JSON.stringify(evidence), /Rival hand sentinel|Later visibility sentinel|Exact draw sentinel|winner/)
  const actionOnly = await (await f.path(f.replay + '/evidence?scope=public&purpose=analysis&includeBefore=false', { headers: f.alice })).json()
  assert.equal(actionOnly.events[0].cursor, 1)
  assert.equal(actionOnly.events[0].before, undefined)
  const review = await (await f.path(f.replay + '/evidence?cursor=2&count=10', { headers: f.alice })).json()
  assert.equal(review.events.filter(row => row.type === 'draw').length, 0, 'a legacy v1 archive does not disclose new draw rows')
})

test('[PM-REVIEW-API-2] protected archive gives exact draws to the recorded seat or authorized full view', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t, { fresh: true })
  const manifest = await (await f.path(f.replay, { headers: f.bob })).json()
  assert.equal(manifest.format, 'Constructed - Pauper', 'a recorded format outside the competitive filter remains identifiable')
  assert.equal(manifest.coverage.version, 2)
  assert.deepEqual(manifest.coverage.draws, { recorded: 1, total: 1 })
  assert.equal(manifest.fullAvailable, true)
  const page = async (query, headers) => (await f.path(f.replay + '/evidence?' + query, { headers })).json()
  const own = await page('scope=seat', f.alice)
  const other = await page('scope=seat&seatId=bob', f.alice)
  const full = await page('scope=full', f.bob)
  const publicPage = await page('scope=public', f.bob)
  assert.deepEqual(own.events.map(row => row.cursor), full.events.map(row => row.cursor))
  assert.match(JSON.stringify(own.events[0]), /Alice known-only sentinel/)
  assert.doesNotMatch(JSON.stringify(own), /Bob known-only sentinel|Rival hand sentinel|Exact draw sentinel/)
  assert.doesNotMatch(JSON.stringify(publicPage), /known-only sentinel|Rival hand sentinel|Exact draw sentinel/)
  assert.match(JSON.stringify(other.events[0]), /Bob known-only sentinel/)
  assert.equal(other.events.find(row => row.type === 'draw').card.name, 'Exact draw sentinel')
  assert.deepEqual(Object.keys(full.events[0].hands).sort(), [f.aliceId, f.bobId].sort())
  assert.equal(full.events.filter(row => row.type === 'draw').length, 1, 'the earlier hand change was not a draw event')
  assert.equal(full.events.find(row => row.type === 'draw').card.name, 'Exact draw sentinel')
  const legacy = await f.path('/api/playtesting/replays/' + f.gameId, { headers: f.alice })
  const playback = await legacy.json()
  assert.doesNotMatch(JSON.stringify(playback), /known-only sentinel|Rival hand sentinel|Exact draw sentinel|Unknown log field sentinel/)
  assert.ok(playback.events.every(event => Number.isInteger(event.cursor)))
  assert.equal(playback.events.at(-1).cursor, full.events.at(-1).cursor)
})

test('[PM-REVIEW-API-2] rollback excludes abandoned decisions without renumbering recorded entries', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t, { rollback: true })
  const result = await (await f.path(f.replay + '/evidence?purpose=analysis', { headers: f.alice })).json()
  assert.deepEqual(result.events.map(event => [event.cursor, event.frameCursor]), [[7, 6]])
  assert.match(result.events[0].actual.text, /retained ability/)
  assert.doesNotMatch(JSON.stringify(result), /Alice plays Forest/)
})

test('[PM-REVIEW-API-4] persisted annotations are anchored, retriable and counted exactly once', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t)
  const manifest = await (await f.path(f.replay, { headers: f.alice })).json()
  const { archiveRevision } = manifest
  const entry = { cursor: 1, seatId: 'alice', confidence: 'medium', assessment: 'sound',
    rationale: 'Preserves the next development step.', benefit: 'Gives a mana source.', risk: 'Commits a public land.', alternatives: [] }
  const put = (entries, headers = f.alice) => f.path(f.replay + '/annotations', json('POST', headers, { archiveRevision, entries }))
  assert.equal((await put([entry], f.outsider)).status, 404)
  assert.equal((await put([{ ...entry, cursor: 0 }])).status, 400)
  const first = await put([entry])
  assert.equal(first.status, 200)
  const initial = (await first.json()).annotations[0]
  assert.equal(initial.category, 'good')
  assert.equal(initial.frameCursor, 0)
  const retry = await put([entry])
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).annotations[0].revision, initial.revision)
  assert.equal((await put([{ ...entry, rationale: 'Different assessment.' }])).status, 409)
  await withTestDatabase(f, db => db.query(
    'UPDATE review_position_coverage SET eligible=0 WHERE game_id=$1 AND seat_key=$2', [f.gameId, 'bob'],
  ))
  const changed = await put([{ ...entry, expectedRevision: initial.revision, rationale: 'Develops without spending mana.' }])
  assert.equal(changed.status, 200)
  const matches = await (await f.path(`${f.root}/matches/${f.matchId}`, { headers: f.alice })).json()
  assert.equal(matches.analysis.reviewed, 1)
  assert.equal(matches.analysis.counts.good, 1)
  assert.equal(matches.games[0].analysis.counts.good, 1)
  const history = await (await f.path('/api/playtesting/matches', { headers: f.alice })).json()
  assert.equal(history.matches[0].analysis.status, 'partial', 'Bob’s recorded pass still has no annotation')
  assert.equal(history.matches[0].analysis.eligible, manifest.analysis.eligible, 'saving refreshes existing candidate counts')
  assert.deepEqual(history.matches[0].analysis.counts, { good: 1 })
  const peer = await (await f.path(f.replay + '/annotations', { headers: f.bob })).json()
  assert.equal(peer.annotations.length, 1)
})

test('[PM-REVIEW-API-4] only participants can read retrospective notes and counts after the match', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t)
  const manifest = await (await f.path(f.replay, { headers: f.alice })).json()
  assert.equal(manifest.fullAvailable, true)
  const record = { cursor: 1, seatId: 'alice', confidence: 'medium', assessment: 'sound',
    rationale: 'Hindsight note sentinel.', benefit: 'Develops mana.', risk: 'Reveals a color.', retrospective: 'Hidden hindsight sentinel.' }
  const notes = f.replay + '/annotations'
  const saved = await f.path(notes, json('POST', f.alice, { archiveRevision: manifest.archiveRevision, entries: [record] }))
  assert.equal(saved.status, 200)
  for (const headers of [f.alice, f.bob]) {
    const view = await f.path(notes, { headers })
    assert.match(await view.text(), /Hidden hindsight sentinel/)
    const history = await (await f.path('/api/playtesting/matches', { headers })).json()
    assert.equal(history.matches[0].analysis.reviewed, 1)
  }
  assert.equal((await f.path(notes, { headers: f.outsider })).status, 404)
})

test('[PM-REVIEW-API-3] qualitative ratings require supported comparison and strictly public source references', { skip: !databaseUrl }, async t => {
  const f = await analysisFixture(t)
  const { archiveRevision } = await (await f.path(f.replay, { headers: f.alice })).json()
  const entry = { cursor: 1, seatId: 'alice', confidence: 'medium', assessment: 'small_loss',
    rationale: 'There may be a better sequencing option.', benefit: 'Develops mana.', risk: 'Reveals a color.' }
  const put = async value => f.path(f.replay + '/annotations', json('POST', f.alice, { archiveRevision, entries: [value] }))
  const comparator = { line: 'Keep the land unplayed this window.', legality: 'confirmed', benefit: 'Hides a color.', risk: 'Delays development.' }
  assert.equal((await put(entry)).status, 400)
  assert.equal((await put({ ...entry, alternatives: [{ ...comparator, legality: 'unverified' }] })).status, 400)
  const reference = { url: 'https://example.com/metagame', date: '2026-11-01', format: 'Pioneer', applicability: 'Explains public matchup probabilities.' }
  assert.equal((await put({ ...entry, alternatives: [comparator], sources: [{ ...reference, url: 'https://example.com/?private=value' }] })).status, 400)
  const accepted = await put({ ...entry, alternatives: [comparator], sources: [reference], confidence: 'low' })
  assert.equal(accepted.status, 200)
  const [annotation] = (await accepted.json()).annotations
  assert.equal(annotation.category, 'insufficient')
  assert.equal(annotation.sources[0].date, reference.date)
})

test('[PM-AC-15] the judge receives pre-action evidence from its own final timeline and scores only supported choices', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const outsider = await signIn(f, 'Carol')
  const matchId = randomUUID()
  const gameId = randomUUID()
  const forest = { name: 'Forest', cardTypes: ['LAND'] }
  const swamp = { name: 'Swamp', cardTypes: ['LAND'] }
  const frame = ({ turn, battlefield = {}, hand = {}, time }) => ({
    t: time,
    view: { turn, step: 'PRECOMBAT_MAIN', phase: 'PRECOMBAT_MAIN', priorityPlayerName: 'Alice', activePlayerName: 'Alice',
      players: [{ name: 'Alice', life: 20, battlefield }, { name: 'Bob', life: 20, topCard: { name: 'Private top card' } }] },
    hands: { Alice: hand, Bob: { unknown: { name: 'Hidden answer' } } },
  })
  await addReplay(f, matchId, gameId, ['Alice', 'Bob'], [
    frame({ turn: 2, time: 100, hand: { swamp, forest } }),
    frame({ turn: 2, time: 200, hand: { swamp }, battlefield: { forest } }),
    { t: 250, kind: 'rollback', turn: 2 },
    frame({ turn: 2, time: 300, hand: { swamp, forest } }),
    frame({ turn: 2, time: 400, hand: { forest }, battlefield: { swamp } }),
    frame({ turn: 3, time: 500, hand: { forest, future: { name: 'Future Draw' } }, battlefield: { swamp } }),
  ])
  await f.product.archiveGames()
  const path = '/api/playtesting/evaluations/' + gameId
  assert.equal((await f.path(path, { headers: outsider })).status, 404)
  const packet = await (await f.path(path, { headers: alice })).json()
  assert.equal(packet.perspective, 'Alice')
  assert.equal(packet.total, 1)
  assert.equal(packet.positions[0].action.card, 'Swamp')
  assert.equal(packet.positions[0].before.hand.length, 2)
  assert.doesNotMatch(JSON.stringify(packet), /Hidden answer|Private top card|Future Draw|winner/)
  const other = await (await f.path(path, { headers: bob })).json()
  assert.equal(other.total, 0)
  const entry = { index: packet.positions[0].index, played: 75, best: 100, confidence: 'high', alternative: 'Forest', reason: 'Keeps green available.' }
  const submit = (positions, headers = alice) => f.path(path, json('POST', headers, { positions }))
  assert.equal((await submit([entry], outsider)).status, 404)
  assert.equal((await submit([{ ...entry, index: 9999 }])).status, 400)
  assert.equal((await submit([entry, entry])).status, 400)
  const report = await (await submit([entry])).json()
  assert.equal(report.accuracy, 75)
  assert.equal(report.scored, 1)
  assert.equal(report.total, 1)
  const uncertain = await (await submit([{ ...entry, confidence: 'low' }])).json()
  assert.equal(uncertain.accuracy, null)
  assert.equal(uncertain.scored, 0)
})

test('[PM-AC-15] a public action can anchor a coalesced frame without inventing the state before later actions', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const gameId = randomUUID()
  const forest = { name: 'Forest', cardTypes: ['LAND'] }
  const elf = { name: 'Llanowar Elves', cardTypes: ['CREATURE'] }
  const view = { turn: 1, step: 'PRECOMBAT_MAIN', activePlayerName: 'Alice',
    priorityPlayerName: 'Bob', players: [{ name: 'Alice' }, { name: 'Bob' }] }
  await addReplay(f, randomUUID(), gameId, ['Alice', 'Bob'], [
    { t: 100, view, hands: { Alice: { forest, elf } } },
    { t: 200, log: { messageType: 'GAME', message: '<font>Alice</font> plays <a>Forest</a> [bea]' } },
    { t: 300, log: { messageType: 'GAME', message: 'Alice casts Llanowar Elves [dec] from hand' } },
    { t: 400, view: { ...view, players: [{ name: 'Alice', battlefield: { forest } }, { name: 'Bob' }] }, hands: { Alice: {} } },
  ])
  await f.product.archiveGames()
  const path = '/api/playtesting/evaluations/' + gameId
  const packet = await (await f.path(path, { headers: alice })).json()
  assert.equal(packet.total, 1)
  assert.deepEqual(packet.positions[0].action, { kind: 'play_land', card: 'Forest' })
  assert.equal(packet.positions[0].evidence, 'engine_log')
  assert.equal(packet.positions[0].before.hand.length, 2)
  assert.equal(packet.positions[0].before.players[0].battlefield.total, 0)
})

test('[PM-AC-11] archive outage leaves the game visible and idempotent retry marks one verified artifact ready', { skip: !databaseUrl }, async t => {
  const objects = new Map()
  let shouldFail = true
  const f = await fixture(t, {
    async put(key, body) {
      if (shouldFail) throw Error('fixture archive unavailable')
      objects.set(key, body)
    },
    async get(key) { return objects.get(key) },
  })
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const match = randomUUID()
  const game = randomUUID()
  await addReplay(f, match, game, ['Alice', 'Bob'])
  await f.product.archiveGames()
  let history = await (await f.path('/api/playtesting/matches', { headers: alice })).json()
  assert.equal(history.matches[0].id, match)
  assert.equal(history.matches[0].games[0].archiveState, 'pending')
  shouldFail = false
  await f.product.archiveGames()
  await f.product.archiveGames()
  history = await (await f.path('/api/playtesting/matches', { headers: alice })).json()
  assert.equal(history.matches[0].games[0].archiveState, 'ready')
  assert.equal(objects.size, 1)
  const response = await f.path(`/api/playtesting/replays/${game}`, { headers: alice })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /secret:Alice/)
  assert.doesNotMatch(text, /secret:Bob|private:Bob|private chat|objectKey/)
})

test('[PM-AC-11] restart interrupts sideboarding even after the prior game archive was collected', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const matchId = randomUUID()
  const gameId = randomUUID()
  const path = '/api/playtesting/matches/' + matchId
  await addReplay(f, matchId, gameId, ['Alice', 'Bob'])
  await f.product.archiveGames()
  let match = await (await f.path(path, { headers: alice })).json()
  assert.equal(match.status, 'active')
  assert.equal(match.games[0].archiveState, 'ready')
  await f.product.archiveGames({ markInterrupted: true })
  match = await (await f.path(path, { headers: alice })).json()
  assert.equal(match.status, 'interrupted')
  assert.equal(match.games[0].status, 'completed')
  assert.equal(match.games[0].archiveState, 'ready')
})

test('[PM-AC-11] startup ingests a finalized match before archiving and keeps its terminal status after retries', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const finishedMatch = '00000000-0000-0000-0000-000000000001'
  const completedGame = 'ffffffff-ffff-ffff-ffff-fffffffffff1'
  const abandonedMatch = randomUUID()
  const abandonedGame = randomUUID()
  await writeFile(join(f.replayDirectory, finishedMatch + '.match.json'), JSON.stringify({
    matchId: finishedMatch, endedAt: Date.now(), winner: 'Alice',
  }))
  await addReplay(f, finishedMatch, completedGame, ['Alice', 'Bob'])
  await addReplay(f, abandonedMatch, abandonedGame, ['Alice', 'Bob'])
  const abandonedFile = join(f.replayDirectory, abandonedGame + '.json')
  const { readFile } = await import('node:fs/promises')
  const abandoned = JSON.parse(await readFile(abandonedFile, 'utf8'))
  abandoned.result = null
  abandoned.winner = null
  await writeFile(abandonedFile, JSON.stringify(abandoned))

  await f.product.archiveGames({ markInterrupted: true })
  async function matches() {
    const response = await f.path('/api/playtesting/matches', { headers: alice })
    assert.equal(response.status, 200)
    return (await response.json()).matches
  }
  let history = await matches()
  assert.equal(history.find(match => match.id === finishedMatch)?.status, 'completed')
  assert.equal(history.find(match => match.id === abandonedMatch)?.status, 'interrupted')
  await f.product.archiveGames()
  await f.product.archiveGames()
  history = await matches()
  const finished = history.find(match => match.id === finishedMatch)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.games[0].archiveState, 'ready')
  const interrupted = history.find(match => match.id === abandonedMatch)
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.games[0].status, 'abandoned')
  assert.equal(interrupted.games[0].archiveState, 'partial')
})

test('[PM-AC-12] bounded batch export preserves only the requesting seat and rejects mixed ownership', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  await signIn(f, 'Carol')
  const game1 = randomUUID()
  const game2 = randomUUID()
  const game3 = randomUUID()
  await addReplay(f, randomUUID(), game1, ['Alice', 'Bob'])
  await addReplay(f, randomUUID(), game2, ['Alice', 'Carol'])
  await addReplay(f, randomUUID(), game3, ['Bob', 'Carol'])
  await f.product.archiveGames()
  assert.equal((await f.path(`/api/playtesting/replays/${game2}`, { headers: bob })).status, 404)
  const exportRoute = '/api/playtesting/exports'
  assert.equal((await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game3] }))).status, 404)
  const result = await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game2] }))
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('content-type'), 'application/zip')
  const { unzipSync, strFromU8 } = await import('fflate')
  const archive = unzipSync(new Uint8Array(await result.arrayBuffer()))
  const content = Object.values(archive).map(strFromU8).join('\n')
  assert.match(content, /secret:Alice/)
  assert.doesNotMatch(content, /secret:Bob|secret:Carol|private:Bob|private:Carol|private chat|objectKey/)
  assert.ok(archive['manifest.json'])
  assert.ok(archive['summary.csv'])
  const response = await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game2], mode: 'handle' }))
  assert.equal(response.status, 201)
  const { path } = await response.json()
  assert.equal((await f.path(path, { headers: alice })).status, 200)
  assert.equal((await f.path(path, { headers: bob })).status, 404)
})

test('[PM-AC-12] grouped stats use finalized games and the requesting player’s deck rather than a global view', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const carol = await signIn(f, 'Carol')
  await signIn(f, 'Bob')
  const match = randomUUID()
  const first = randomUUID()
  const second = randomUUID()
  await addReplay(f, match, first, ['Alice', 'Bob'])
  await addReplay(f, match, second, ['Bob', 'Alice'])
  for (const [gameId, mulligans] of [[first, 0], [second, 2]]) {
    const file = join(f.replayDirectory, gameId + '.json')
    const { readFile } = await import('node:fs/promises')
    const info = JSON.parse(await readFile(file, 'utf8'))
    info.startPlayer = 'Alice'
    info.players.find(seat => seat.name === 'Alice').mulligans = mulligans
    await writeFile(file, JSON.stringify(info))
  }
  await f.product.archiveGames()
  let response = await f.path('/api/playtesting/stats?format=Pioneer', { headers: alice })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { groups: [], totals: { matches: 0, games: 0, wins: 0 } })
  await writeFile(join(f.replayDirectory, match + '.match.json'), JSON.stringify({ matchId: match, endedAt: Date.now(), winner: 'Alice' }))
  await f.product.archiveGames()
  response = await f.path('/api/playtesting/stats?format=Pioneer', { headers: alice })
  const { groups: [group], totals } = await response.json()
  assert.deepEqual(totals, { matches: 1, games: 2, wins: 1 })
  assert.equal(group.games, 2)
  assert.equal(group.wins, 1)
  assert.equal(group.onPlay, 2)
  assert.equal(group.onDraw, 0)
  assert.equal(group.averageMulligans, 1)
  assert.equal(group.averageTurns, 4)
  assert.doesNotMatch(JSON.stringify(group), /private:Bob/)
  assert.deepEqual(await (await f.path('/api/playtesting/stats', { headers: carol })).json(), { groups: [], totals: { matches: 0, games: 0, wins: 0 } })
  // A new registered list starts a new match. All of its post-board games
  // remain attributed to the opening list, regardless of their card signature.
  await f.product.setUnlimitedMatchHistory(['Alice'], true)
  await withTestDatabase(f, db => db.query(
    `WITH extra_matches AS (
       INSERT INTO matches(id,table_id,format,started_at,status,winner)
       SELECT gen_random_uuid(),gen_random_uuid(),'Pioneer',n,'completed','Alice' FROM generate_series(1,101) n RETURNING id
     ), extra_games AS (
       INSERT INTO games(id,match_id,started_at,game_number,winner,status,archive_state)
       SELECT gen_random_uuid(),id,1,1,'Alice','completed','ready' FROM extra_matches RETURNING id
     )
     INSERT INTO game_players(game_id,engine_key,engine_name,human,deck_snapshot)
     SELECT id,'alice','Alice',true,jsonb_build_object('cards',jsonb_build_array(id::text)) FROM extra_games`))
  const capped = await (await f.path('/api/playtesting/stats?format=Pioneer', { headers: alice })).json()
  assert.equal(capped.groups.length, 100)
  assert.deepEqual(capped.totals, { matches: 102, games: 103, wins: 102 })
  const otherFormat = await (await f.path('/api/playtesting/stats?format=Modern', { headers: alice })).json()
  assert.deepEqual(otherFormat.totals, { matches: 0, games: 0, wins: 0 })

})

test('social discovery classifies real delegated identities without guessing from names or deleting progress', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  await signIn(f, 'SocialOwner')
  // Human created before the prefix became reserved retains their existing name.
  await withTestDatabase(f, db => db.query(`INSERT INTO accounts(id,username,username_key,password_hash)
    VALUES($1,'mcp_abcdef1234','mcp_abcdef1234','disabled-fixture')`, [randomUUID()]))
  const grant = await f.product.provisionAgent('SocialOwner', 'LegacyRival', ['play', 'chat'])
  const before = await f.path('/internal/verify?scope=play', { headers: { Authorization: 'Bearer ' + grant } })
  assert.equal(before.status, 200)
  await withTestDatabase(f, db => db.query(`INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes,oauth_managed)
    SELECT $1,id,'mcp_1234567890','mcp_1234567890',ARRAY['play','chat'],true FROM accounts WHERE username_key='socialowner'`, [randomUUID()]))
  const response = await f.path('/internal/social/agents')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), ['legacyrival', 'mcp_1234567890'])
  assert.equal((await f.path('/internal/verify?scope=play', { headers: { Authorization: 'Bearer ' + grant } })).status, 200)
  await withTestDatabase(f, async db => {
    const { rows: [row] } = await db.query("SELECT count(*)::int AS count FROM agent_grants WHERE engine_key='legacyrival'")
    assert.equal(row.count, 1)
    await db.query("UPDATE agent_grants SET revoked_at=now() WHERE engine_key='legacyrival'")
  })
  assert.deepEqual(await (await f.path('/internal/social/agents')).json(), ['legacyrival', 'mcp_1234567890'])
  const external = await fixture(t, new Map(), { enableInternal: false })
  assert.equal((await external.path('/internal/social/agents')).status, 404)
})

const signupPath = '/api/playtesting/signup'

test('[PM-SIGNUP-AC-04] browser auth verifies a fresh challenge for the correct action and hostname', { skip: !databaseUrl }, async t => {
  const mails = []
  const verifications = []
  const f = await fixture(t, new Map(), {
    publicUrl: 'https://playmat.example.test',
    signup: { async send(mail) { mails.push(mail) } },
    turnstile: {
      siteKey: 'fixture-public-key',
      secret: 'synthetic-fixture-value',
      async fetch(url, options) {
        assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
        assert.equal(options.method, 'POST')
        assert.equal(options.redirect, 'error')
        assert.equal(options.body.get('secret'), 'synthetic-fixture-value')
        const token = options.body.get('response')
        verifications.push(token)
        if (token === 'provider-error') throw Error('synthetic provider timeout')
        return Response.json({
          success: token !== 'rejected',
          hostname: token === 'wrong-host' ? 'foreign.example.test' : 'playmat.example.test',
          action: token.startsWith('login-') ? 'password-login' : 'turnstile-spin-v2',
        })
      },
    },
  })
  const request = turnstileToken => f.path(signupPath + '/request',
    json('POST', {}, { email: 'signup@example.test', turnstileToken }))
  const config = await f.path(signupPath + '/config')
  assert.deepEqual(await config.json(), { turnstileSiteKey: 'fixture-public-key' })
  for (const token of [undefined, 'a'.repeat(2049)]) assert.equal((await request(token)).status, 403)
  assert.deepEqual(verifications, [])
  for (const token of ['rejected', 'wrong-host', 'login-other-action']) assert.equal((await request(token)).status, 403)
  assert.equal((await request('provider-error')).status, 503)
  assert.equal(mails.length, 0)
  const signed = await Promise.all([request('registration-token'), request('registration-token')])
  assert.deepEqual(signed.map(r => r.status).sort(), [202, 403])
  assert.equal(mails.length, 1)
  assert.equal(verifications.filter(token => token === 'registration-token').length, 1)

  await f.product.provisionHuman('ProtectedPlayer', password)
  const page = await f.path('/login')
  const html = await page.text()
  assert.match(html, /data-sitekey="fixture-public-key"/)
  assert.match(html, /data-action="password-login"/)
  assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/challenges.cloudflare.com/)
  const login = (token = '', givenPassword = password) => f.path('/login', {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ username: 'ProtectedPlayer', password: givenPassword, 'cf-turnstile-response': token }),
  })
  assert.equal((await login()).status, 403)
  assert.equal((await login('signup-action')).status, 403)
  const invalid = await login('login-wrong-password', 'incorrect')
  assert.equal(invalid.status, 401)
  assert.match(await invalid.text(), /data-sitekey="fixture-public-key"/)
  assert.equal((await login('login-wrong-password')).status, 403)
  const signedIn = await login('login-fresh-token')
  assert.equal(signedIn.status, 303)
  assert.match(signedIn.headers.get('set-cookie'), /HttpOnly/)
})

function signupFixture(t, send = async () => {}) {
  const messages = []
  const signup = { async send(message) {
    await send(message)
    messages.push(message)
  } }
  return fixture(t, new Map(), { publicUrl: 'https://playmat.example.test', signup }).then(f => ({
    ...f, messages,
    request: email => f.path(`${signupPath}/request`, json('POST', {}, { email })),
    complete: (token, username, secret = password) => f.path(`${signupPath}/complete`, json('POST', {}, { token, username, password: secret })),
    token: () => new URLSearchParams(new URL(messages.at(-1).url).hash.slice(1)).get('token'),
  }))
}

test('[PM-SIGNUP-AC-01] creates a password account only after email verification', { skip: !databaseUrl }, async t => {
  const f = await signupFixture(t)
  const joinPath = '/join/' + randomUUID()
  const loginPage = await f.path('/login?next=' + encodeURIComponent(joinPath))
  const loginHtml = await loginPage.text()
  assert.match(loginHtml, /<title>Thoughtseize · Entrar<\/title>/)
  assert.match(loginHtml, /<h1>Thoughtseize<\/h1>/)
  assert.ok(loginHtml.includes('href="/register?next=' + encodeURIComponent(joinPath) + '"'))
  assert.equal((await f.request('  Player@EXAMPLE.test  ')).status, 202)
  assert.equal(f.messages.length, 1)
  assert.equal(f.messages[0].to, 'player@example.test')
  const url = new URL(f.messages[0].url)
  assert.equal(url.origin, 'https://playmat.example.test')
  assert.equal(url.pathname, '/register/complete')
  assert.equal(url.search, '')
  const token = f.token()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  await withTestDatabase(f, async db => {
    assert.equal((await db.query('SELECT 1 FROM accounts')).rowCount, 0)
    const { rows: [record] } = await db.query('SELECT token_digest FROM signup_links')
    assert.match(record.token_digest, /^[a-f0-9]{64}$/)
  })
  const created = await f.complete(token, 'EmailPlayer')
  assert.equal(created.status, 201, await created.clone().text())
  const session = created.headers.get('set-cookie')
  assert.match(session, /HttpOnly/)
  assert.equal((await f.path('/api/playtesting/me', { headers: { Cookie: session.split(';')[0] } })).status, 200)
  const login = await f.path('/login', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'EmailPlayer', password }),
  })
  assert.equal(login.status, 303)
  assert.equal((await f.request('PLAYER@example.test')).status, 202)
  assert.equal(f.messages.length, 1)
})

test('[PM-SIGNUP-AC-02] rejects expired and reused links and preserves valid links after input conflicts', { skip: !databaseUrl }, async t => {
  const f = await signupFixture(t)
  await f.product.provisionHuman('Existing', password)
  assert.equal((await f.request('claim@example.test')).status, 202)
  const token = f.token()
  assert.equal((await f.complete(token, 'a'.repeat(15))).status, 400)
  for (const reserved of ['mcp', 'McpAlice', 'MCP_Bob']) {
    assert.equal((await f.complete(token, reserved)).status, 400)
    await assert.rejects(f.product.provisionHuman(reserved, password), { status: 400 })
  }
  assert.equal((await f.complete(token, 'NewPlayer', 'short')).status, 400)
  assert.equal((await f.complete(token, 'existing')).status, 409)
  const results = await Promise.all([f.complete(token, 'NewPlayer'), f.complete(token, 'OtherPlayer')])
  assert.deepEqual(results.map(r => r.status).sort(), [201, 410])
  assert.equal((await f.complete(token, 'NewPlayer')).status, 410)
  assert.equal((await f.request('expired@example.test')).status, 202)
  const expired = f.token()
  await withTestDatabase(f, db => db.query("UPDATE signup_links SET expires_at=now() WHERE email='expired@example.test'"))
  assert.equal((await f.complete(expired, 'ExpiredPlayer')).status, 410)
})

test('[PM-SIGNUP-AC-03] limits delivery and releases failed delivery for retry', { skip: !databaseUrl }, async t => {
  let attempts = 0
  const f = await signupFixture(t, async () => { if (++attempts === 1) throw new Error('synthetic provider failure') })
  assert.equal((await f.request('invalid')).status, 400)
  assert.equal((await f.path(`${signupPath}/request`, json('POST', { Origin: 'https://foreign.example' }, { email: 'test@example.test' }))).status, 403)
  assert.equal((await f.request('retry@example.test')).status, 503)
  assert.equal((await f.request('retry@example.test')).status, 202)
  assert.equal((await f.request('retry@example.test')).status, 202)
  assert.equal(f.messages.length, 1)
  for (let n = 0; n < 32; n += 1) {
    if ((await f.request(`test${n}@example.test`)).status === 429) break
  }
  assert.equal((await f.request('blocked@example.test')).status, 429)
  const off = await fixture(t)
  assert.equal((await signIn(off, 'ExistingUser')).Cookie.startsWith('playmat-session='), true)
  assert.equal((await off.path(`${signupPath}/request`, json('POST', {}, { email: 'new@example.test' }))).status, 503)
})


test('match participants retain their own declared model across retries, archive scans and invitation removal', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const seat = async (owner, name) => ({ Authorization: 'Bearer ' + await f.product.provisionAgent(owner, name, ['play','history']) })
  const host = await seat('Alice', 'AgentAlice')
  const guest = await seat('Bob', 'OldRival')
  const tableId = randomUUID()
  const gameId = randomUUID()
  const invites = '/api/playtesting/invites'
  const payload = { tableId, roomId: randomUUID(), password, format: 'Pioneer', guestEngineName: 'OldRival' }
  const claim = data => f.path(invites + '/' + tableId + '/claim', json('POST', guest, data))
  const runtime = { model: 'vendor/model-2.1', reasoningEffort: 'high' }
  assert.equal((await f.path(invites, json('POST', alice, { ...payload, ...runtime }))).status, 400)
  assert.equal((await f.path(invites, json('POST', host, { ...payload, ...runtime }))).status, 201)
  assert.equal((await claim({ reasoningEffort: '<bad>' })).status, 400)
  assert.equal((await claim({ model: 'model-B' })).status, 200)
  assert.equal((await claim({ model: 'different', reasoningEffort: 'high' })).status, 200)
  const info = await (await f.path(invites + '/' + tableId, { headers: host })).json()
  assert.equal(info.guestOwnerName, 'Bob')
  await addReplay(f, tableId, gameId, ['AgentAlice', 'OldRival'])
  await f.product.archiveGames()
  await withTestDatabase(f, db => db.query('DELETE FROM invitations WHERE table_id=$1', [tableId]))
  const replay = await (await f.path('/api/playtesting/replays/' + gameId, { headers: host })).json()
  assert.equal(replay.info.viewerName, 'agentalice')
  assert.deepEqual(replay.info.players, [
    { name: 'AgentAlice', displayName: 'Alice', human: true, isMcp: true, ...runtime },
    { name: 'OldRival', displayName: 'Bob', human: true, isMcp: true, model: 'model-B', reasoningEffort: null },
  ])
  const directory = '/api/playtesting/player-identities?names=Alice,OLDRIVAL,Unknown'
  assert.equal((await f.path(directory)).status, 401)
  const lookup = await (await f.path(directory, { headers: alice })).json()
  assert.deepEqual(lookup.players.sort((a,b) => a.name.localeCompare(b.name)), [
    { name: 'Alice', displayName: 'Alice', isMcp: false },
    { name: 'OldRival', displayName: 'Bob', isMcp: true },
  ])
})

test('upgrading a random OAuth seat keeps existing credentials, history perspective and recovery ownership', { skip: !databaseUrl }, async t => {
  const issuer = 'https://playmat.example.test'
  const f = await fixture(t, new Map(), { publicUrl: issuer })
  const { newToken, digest } = await import('./identity.mjs')
  const owner = await signIn(f, 'FourteenPlayer')
  const other = await signIn(f, 'Other')
  const old = 'mcp_a001b002c0'
  await assert.rejects(f.product.provisionAgent('Other', 'MCP_FourteenPlayer', ['play']), { status: 400 })
  await assert.rejects(f.product.importProvisionBundle({ agents: [{ owner: 'Other', engineName: 'mcp_FourteenPlayer', tokenDigest: digest(newToken()), scopes: ['play'] }] }), { status: 400 })
  const access = newToken()
  const connection = randomUUID()
  const recovery = randomUUID()
  const headers = { Authorization: 'Bearer ' + access }
  await withTestDatabase(f, async db => {
    const { rows: [account] } = await db.query("SELECT id FROM accounts WHERE username='FourteenPlayer'")
    await db.query(`INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes,oauth_managed,recovery_id)
      VALUES($1,$2,$3,$3,ARRAY['play','history'],true,$4)`, [digest(newToken()), account.id, old, recovery])
    await db.query(`INSERT INTO oauth_connections(id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at)
      VALUES($1,$2,$3,'client',$4,ARRAY['play','history'],$5,now()+interval '1 hour')`,
    [connection, account.id, old, issuer + '/mcp', digest(newToken())])
    await db.query("INSERT INTO oauth_access_tokens VALUES($1,$2,now()+interval '1 hour')", [digest(access), connection])
  })
  const legacy = await historyMatch(f, [old, 'Other'], Date.now())
  await f.product.archiveGames()
  const migrate = await readFile(new URL('./player-identities.sql', import.meta.url), 'utf8')
  await withTestDatabase(f, async db => { await db.query(migrate); await db.query(migrate) })
  const identity = await (await f.path('/internal/verify', { headers })).json()
  assert.equal(identity.engineName, 'mcp_FourteenPlayer')
  assert.equal(identity.recoverySeatId, 'agent:' + recovery)
  assert.equal(identity.connectionId, connection)
  const history = await (await f.path('/api/playtesting/matches', { headers })).json()
  assert.equal(history.matches[0].id, legacy.id)
  const game = history.matches[0].games[0]
  assert.equal(game.viewerName, old)
  assert.deepEqual(game.players.find(seat => seat.name === old),
    { name: old, human: true, isMcp: true, displayName: 'FourteenPlayer', model: null, reasoningEffort: null })
  assert.equal((await f.path('/api/playtesting/replays/' + game.gameId, { headers: other })).status, 200)
  assert.equal((await f.path('/api/playtesting/replays/' + game.gameId, { headers: owner })).status, 404)
  const privacy = await (await f.path(reviewPrivacy + '/matches/' + legacy.id, { headers })).json()
  assert.equal(privacy.viewerSeatId, old)
})

test(
  'deck performance reconstructs a registered Bo3, an exact kept hand and public matchup evidence',
  { skip: !databaseUrl },
  async (t) => {
    const f = await fixture(t)
    const alice = await signIn(f, 'Alice')
    const bob = await signIn(f, 'Bob')
    const outsider = await signIn(f, 'Outsider')
    const library = '/api/playtesting/decks/'
    const deck = {
      name: 'League list',
      format: 'Pioneer',
      archetype: 'Golgari Midrange',
      cards: [{ cardName: 'Forest', amount: 60 }],
      sideboard: [{ cardName: 'Duress', amount: 1 }],
    }
    const save = (data, expectedRevision) => f.path(library + 'golgari', json('PUT', alice, { data, expectedRevision }))
    assert.equal((await save(deck, 0)).status, 200)
    const revised = { ...deck, cards: [{ cardName: 'Swamp', amount: 60 }] }
    assert.equal((await save(revised, 1)).status, 200)
    const match = randomUUID(),
      own = randomUUID(),
      rival = randomUUID()
    const gameIds = [randomUUID(), randomUUID(), randomUUID()]
    const winner = ['Alice', 'Bob', 'Alice']
    const card = (name, ownerId, extra) => ({ name, ownerId, ...extra })
    for (let n = 0; n < 3; n++) {
      const id = gameIds[n]
      const metadata = {
        gameId: id,
        matchId: match,
        tableId: match,
        startedAt: 1000 + n,
        endedAt: 2000 + n,
        gameNumber: n + 1,
        winsNeeded: 2,
        result: 'Complete',
        winner: winner[n],
        startPlayer: n === 1 ? 'Bob' : 'Alice',
        deckType: 'Constructed - Pioneer',
        players: [
          {
            name: 'Alice',
            playerId: own,
            human: true,
            mulligans: n,
            deck:
              n === 0
                ? deck
                : {
                    ...deck,
                    cards: [
                      { cardName: 'Forest', amount: 59 },
                      { cardName: 'Duress', amount: 1 },
                    ],
                    sideboard: [{ cardName: 'Forest', amount: 1 }],
                  },
          },
          { name: 'Bob', playerId: rival, human: true, mulligans: n === 1 ? 1 : 0 },
        ],
      }
      await writeFile(join(f.replayDirectory, id + '.json'), JSON.stringify(metadata))
      const rows = [
        { kind: 'action', action: 'mulligan', actorPlayerId: own, decision: { cards: [{ name: 'Rejected' }] } },
        { kind: 'action', action: 'keep', actorPlayerId: rival, decision: { cards: [{ name: 'Hidden rival keep' }] } },
        ...(n === 1
          ? []
          : [
              {
                kind: 'action',
                action: 'keep',
                actorPlayerId: own,
                decision: { cards: [{ name: 'Forest' }, { name: 'Forest' }, ...(n === 2 ? [{ name: 'Duress' }] : [])] },
              },
            ]),
        {
          view: {
            turn: 1,
            step: 'PRECOMBAT_MAIN',
            players: [
              { name: 'Alice', playerId: own, battlefield: {} },
              {
                name: 'Bob',
                playerId: rival,
                battlefield: {
                  a: card('Monastery Swiftspear', rival),
                  b: card('Hidden permanent', rival, { faceDown: true }),
                  c: card('Stolen forest', own),
                  d: card('Goblin', rival, { isToken: true }),
                },
              },
            ],
          },
          hands: { Bob: { e: { name: 'Hidden hand' } } },
        },
      ]
      await writeFile(
        join(f.replayDirectory, id + '.ndjson.gz'),
        gzipSync(rows.map((row) => JSON.stringify(row)).join('\n')),
      )
    }
    await writeFile(
      join(f.replayDirectory, match + '.match.json'),
      JSON.stringify({ matchId: match, endedAt: 2010, winner: 'Alice' }),
    )
    await f.product.archiveGames()
    const performance = async (headers, query) => {
      const response = await f.path('/api/playtesting/performance?' + query, { headers })
      assert.equal(response.status, 200)
      return response.json()
    }
    const rec = (wins, losses) => ({ total: wins + losses, wins, losses, draws: 0 })
    const restricted = { Authorization: 'Bearer ' + (await f.product.provisionAgent('Alice', 'OnlyHistory', ['history'])) }
    assert.equal((await f.path('/api/playtesting/performance?scope=all', { headers: restricted })).status, 403)
    const latest = await performance(alice, 'deckId=golgari')
    assert.equal(latest.selected.version, 2)
    assert.equal(latest.summary.matches.total, 0)
    const data = await performance(alice, 'deckId=golgari&version=1&bestOf=3')
    assert.deepEqual(data.summary, { matches: rec(1, 0), games: rec(2, 1) })
    assert.deepEqual(data.splits, { preboard: rec(1, 0), postboard: rec(1, 1), play: rec(2, 0), draw: rec(0, 1) })
    assert.deepEqual(data.openingCards, [
      { card: 'Forest', games: rec(2, 0), without: rec(0, 0) },
      { card: 'Duress', games: rec(1, 0), without: rec(1, 0) },
    ], 'the loss with an unknown keep cannot enter either cohort')
    assert.deepEqual(data.opponentCards, [
      { card: 'Monastery Swiftspear', games: rec(2, 1), gameIds: [gameIds[1], gameIds[0], gameIds[2]] },
    ])
    assert.deepEqual(data.coverage, { keptHands: 2, opponentCards: 3, games: 3 })
    assert.deepEqual(data.matchIds, [match])
    assert.deepEqual(data.matchups[0].mulligans, { known: 3, taken: 2, opponentKnown: 3, opponentTaken: 1 })
    assert.doesNotMatch(JSON.stringify(data), /Hidden rival keep|Hidden permanent|Hidden hand|Stolen forest|Rejected/)
    assert.equal((await performance(alice, 'deckId=golgari&scope=deck')).summary.games.total, 3)
    assert.equal((await performance(alice, 'deckId=golgari&version=1&bestOf=1')).summary.games.total, 0)
    assert.equal((await performance(outsider, 'scope=all')).summary.games.total, 0)
    assert.doesNotMatch(
      JSON.stringify(await performance(bob, 'scope=all&includeCards=true')),
      /golgari|League list|Rejected/,
    )
    const landing = await performance(alice, 'scope=all')
    assert.deepEqual(
      landing.groups.map((g) => [g.format, g.archetype, g.matches, g.games]),
      [['Pioneer', 'Golgari Midrange', rec(1, 0), rec(2, 1)]],
    )
    assert.deepEqual(landing.groups[0].deckIds, ['golgari'])
    // An identical saved copy makes the legacy source ambiguous. A declared
    // starting list resolves it and shares only the opponent's matchup label.
    await f.path(library + 'copy', json('PUT', alice, { expectedRevision: 0, data: { ...deck, name: 'League copy' } }))
    assert.equal((await performance(alice, 'deckId=golgari&version=1')).summary.games.total, 0)
    assert.equal((await performance(alice, 'scope=all')).summary.games.total, 3)
    await withTestDatabase(f, async (db) => {
      await db.query(
        `INSERT INTO match_deck_registrations(table_id,engine_key,account_id,deck_id,list_version,list_signature,archetype,deck_name)
      SELECT $1,'alice',account_id,deck_id,list_version,list_signature,archetype,name FROM deck_revisions
      WHERE deck_id='golgari' AND revision=1`,
        [match],
      )
      await db.query(
        `INSERT INTO match_deck_registrations(table_id,engine_key,account_id,deck_id,list_version,list_signature,archetype,deck_name)
      SELECT $1,'bob',id,'private-rival-deck',1,'private-rival-signature','Rakdos Midrange','Private rival title'
      FROM accounts WHERE username_key='bob'`,
        [match],
      )
    })
    const registered = await performance(alice, 'deckId=golgari&version=1&opponentArchetype=Rakdos%20Midrange')
    assert.deepEqual(registered.summary, data.summary)
    assert.equal(registered.matchups[0].archetype, 'Rakdos Midrange')
    assert.doesNotMatch(JSON.stringify(registered), /private-rival|Private rival title/)
    assert.equal((await performance(alice, 'deckId=golgari&version=1&opponentArchetypeUnknown=true')).summary.games.total, 0)
  },
)

test(
  'history and performance can filter a noncompetitive format and keep a verified Bo1 distinct',
  { skip: !databaseUrl },
  async (t) => {
    const f = await fixture(t)
    const alice = await signIn(f, 'Alice')
    const id = randomUUID(),
      gameId = randomUUID()
    const format = 'Constructed - Freeform'
    await addReplay(f, id, gameId, ['Alice', 'Bob'])
    const file = join(f.replayDirectory, gameId + '.json')
    const snapshot = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...snapshot, deckType: format, winsNeeded: 1 }))
    await writeFile(
      join(f.replayDirectory, id + '.match.json'),
      JSON.stringify({ matchId: id, endedAt: Date.now(), winner: 'Alice' }),
    )
    await f.product.archiveGames()
    const read = async (route) => {
      const response = await f.path('/api/playtesting/' + route, { headers: alice })
      assert.equal(response.status, 200)
      return response.json()
    }
    const query = new URLSearchParams({ format }).toString()
    const list = await read('matches?' + query)
    assert.deepEqual(
      list.matches.map((m) => [m.id, m.format, m.games[0].deckType]),
      [[id, format, format]],
    )
    const detail = await read('performance?scope=all&bestOf=1&' + query)
    assert.deepEqual(detail.observedBestOf, [1])
    assert.deepEqual(detail.summary.matches, detail.summary.games)
    assert.equal(detail.summary.games.wins, 1)
    assert.equal((await read('performance?scope=all&bestOf=3&' + query)).summary.games.total, 0)
  },
)
