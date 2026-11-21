// Explicit fixture harness, never run by npm test. Requires the isolated container opt-in below.
import { fixtureMcpFetch } from './fixture-mcp-fetch.mjs'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { createProduct } from './product.mjs'
import { PlaymatEngineSeat } from '../mcp/src/engine-seat.mjs'

if (process.env.PLAYMAT_RECOVERY_LOCAL_TEST !== 'yes'
  || !process.env.DATABASE_URL?.includes('@playmat-recovery-pg:5432/recovery_fixture')) throw Error('Isolated recovery fixture required')
const require = createRequire(new URL('../mcp/package.json', import.meta.url))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
const base = 'http://127.0.0.1:8080'
const file = '/var/lib/playmat/saved/recovery-fixture.json'
const password = 'isolated-recovery-fixture-only'
const deck = { name: 'Recovery fixture', cards: [
  { cardName: 'Forest', amount: 24 },
  ...['Bomat Courier', 'Memnite', 'Ornithopter', 'Abundant Growth', 'Gingerbrute', 'Young Wolf', 'Rancor', 'Skarrgan Pit-Skulk', 'Llanowar Elves']
    .map(cardName => ({ cardName, amount: 4 })),
], sideboard: [{ cardName: 'Mountain', amount: 1 }] }
const mode = process.argv[2]
let browser, outsider, mcp, otherGrant
async function save(data) { await writeFile(file, JSON.stringify(data), { mode: 0o600 }) }
async function login(name, forged = false) {
  const response = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: name, password }) })
  assert.equal(response.status, 303)
  const cookie = response.headers.get('set-cookie').split(';')[0]
  const engine = new PlaymatEngineSeat({ engineUrl: 'ws://127.0.0.1:8080/ws', engineName: name, trustedHeader: 'X-Playmat-User',
    authenticationHeaders: { Cookie: cookie, ...(forged ? { 'X-Playmat-User': 'RecoveryAlice', 'X-Playmat-Account': forged.accountId, 'X-Playmat-Seat': forged.seatId } : {}) },
  })
  await engine.open()
  engine.fixtureCookie = cookie
  return engine
}
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args })
  const data = JSON.parse(response.content[0].text)
  if (response.isError) throw Object.assign(Error(name + ': ' + data.message), { code: data.code })
  return data
}
async function clients(fixture) {
  browser = await login('RecoveryAlice')
  mcp = new Client({ name: 'isolated-recovery-fixture', version: '1.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    fetch: fixtureMcpFetch, requestInit: { headers: { Authorization: 'Bearer ' + fixture.token } },
  }))
}
async function states() { return [browser.snapshot(), await call('get_game_state')] }
async function until(predicate, description, seconds = 30) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    const state = await states()
    if (await predicate(state)) return state
    await sleep(75)
  }
  const state = await states()
  throw Error('Timed out: ' + description + ' ' + JSON.stringify(state.map(s => ({ status: s.status, turn: s.turn, step: s.step, decision: s.decision?.kind }))))
}
const attempted = new Set()
function deckSignature(deck) {
  return JSON.stringify(['cards', 'sideboard'].map(zone => {
    const cards = new Map()
    for (const card of deck[zone] ?? []) {
      const key = JSON.stringify([card.cardName, card.setCode ?? '', card.cardNumber ?? ''])
      cards.set(key, (cards.get(key) ?? 0) + card.amount)
    }
    return [zone, [...cards].sort(([a], [b]) => a.localeCompare(b))]
  }))
}
async function choose(index, state, cast = true) {
  if (!state.decision || state.status !== 'active') return false
  const choices = state.decision.choices
  const land = choices.find(c => c.card?.types?.includes('LAND') && state.ownHand?.some(card => card.id === c.card.id))
  const spell = cast && choices.find(c => c.card && state.ownHand?.some(card => card.id === c.card.id)
    && !attempted.has(state.turn + ':' + c.card.id) && /Bomat Courier|Abundant Growth|Memnite|Ornithopter|Young Wolf|Llanowar Elves/.test(c.card.name))
  const attack = choices.find(c => /Bomat Courier/.test(c.card?.name ?? '') && /attack/i.test(state.decision.kind)
    && !attempted.has('attack:' + state.turn + ':' + c.card.id))
  const mana = /mana/i.test(state.decision.kind) && choices.find(c => c.card?.name === 'Forest' || c.type === 'mana')
  // Paying with an enchanted Forest can open an ability picker and then a color picker.
  // Resolve the legal mana option before falling back to a panel's Cancel button.
  const manaAbilities = choices.filter(c => c.type === 'option' && c.abilityType === 'ACTIVATED_MANA')
  const manaMode = state.decision.kind === 'panel' && (manaAbilities.find(c => /Add\s*\{G\}/i.test(c.label))
    || manaAbilities[0] || (/^Choose(?: a)? color\b/i.test(state.decision.instruction)
      && choices.find(c => c.type === 'option' && c.label === 'Green')))
  const target = /target/i.test(state.decision.kind) && choices.find(c => c.type === 'object')
  const picked = land || spell || attack || mana || manaMode || target || choices.find(c => /^Keep\b|^Play first\b/.test(c.label))
    || choices.find(c => c.type === 'pass') || choices.find(c => c.type === 'button') || choices[0]
  if (!picked) return false
  if (spell === picked) attempted.add(state.turn + ':' + picked.card.id)
  if (attack === picked) attempted.add('attack:' + state.turn + ':' + picked.card.id)
  try {
    if (index === 0) await browser.respond(state.decision.id, picked.id)
    else await call('submit_decision', { gameId: state.gameId, cursor: state.cursor, decisionId: state.decision.id, choiceId: picked.id, idempotencyKey: randomUUID() })
    return true
  } catch (e) {
    if (['stale_decision', 'stale_state', 'engine_rejected', 'engine_timeout', 'illegal_choice', 'decision_busy'].includes(e.code)
      || (e.code === -32602 && e.message === 'The expected decision is no longer pending')) return false
    throw e
  }
}
async function playTo(turn) {
  const end = Date.now() + 120_000
  let last
  while (Date.now() < end) {
    const state = await states()
    const records = await browser.recoveryList()
    const row = records.find(r => r.status === 'live' && r.phase === 'turn')
    last = { durableTurn: row?.turn ?? null, seats: state.map(s => ({ turn: s.turn, step: s.step, decision: s.decision?.kind })) }
    if (row?.turn >= turn && state[1].decision?.kind === 'priority') return { state, row }
    let acted = false
    for (let i = 0; i < 2; i++) acted = await choose(i, state[i]) || acted
    if (!acted) await sleep(60)
  }
  throw Error('No durable turn reached: ' + JSON.stringify(last))
}
async function concedeAndWaitFor(status, description) {
  await browser.concede(browser.snapshot().gameId, false)
  // XMage processes a non-priority concession at the next game-thread safe
  // point. Managed MCP seats can have priority in upkeep and draw as well.
  return until(async state => {
    if (state.every(s => s.status === status)) return true
    await choose(1, state[1], false)
    return false
  }, description)
}
async function completeMatch(fixture) {
  const ended = await concedeAndWaitFor('match_over', 'whole best-of-three match completed')
  assert.equal(ended[1].score.wins, 2)
  assert.equal(ended[0].score.wins, 0)
  assert.equal(ended[0].score.losses, 2)
  assert.equal(ended[1].score.losses, 0)
  const completed = await browser.recoveryStatus(fixture.matchId)
  assert.equal(completed.status, 'completed')
  const repeated = await call('recover_match', { matchId: fixture.matchId, revision: completed.revision, agree: true })
  assert.equal(repeated.status, 'completed')
  assert.equal(repeated.generation, completed.generation)
  console.log(JSON.stringify({ phase: 'whole-match-completed', generation: completed.generation, score: ended[1].score }))
}
try {
  if (mode === 'prepare') {
    const product = await createProduct({ databaseUrl: process.env.DATABASE_URL })
    const token = randomBytes(32).toString('base64url')
    let aliceId
    const engineName = 'rec_' + randomBytes(3).toString('hex')
    try {
      for (const name of ['RecoveryAlice', 'RecoveryBob', 'RecoveryEve']) {
        let id
        try { id=await product.provisionHuman(name, password) }
        catch(e) { if(e.status!==409) throw e }
        if(name==='RecoveryAlice') aliceId=id
      }
      await product.provisionAgent('RecoveryBob', engineName, ['play', 'library', 'history', 'chat'], token)
    } finally { await product.close() }
    const fixture = { token, aliceId, engineName }
    await clients(fixture)
    fixture.aliceId = (await (await fetch(base + '/api/playtesting/me', { headers: { Cookie: browser.fixtureCookie } })).json()).accountId
    await save(fixture)
    const created = await browser.createGame({ name: 'Isolated recovery acceptance', format: 'Modern', deck, matchTimeLimit: 'MIN___5', seed: 77 }, async (record) => {
      const cookieResponse = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'RecoveryAlice', password }) })
      const response = await fetch(base + '/api/playtesting/invites', { method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookieResponse.headers.get('set-cookie').split(';')[0] }, body: JSON.stringify({ ...record, guestEngineName: engineName }) })
      assert.equal(response.status, 201)
      return response.json()
    })
    await call('join_game', { tableId: created.tableId, deck })
    await browser.startMatch(created.tableId)
    const { state, row } = await playTo(9)
    Object.assign(fixture, { matchId: row.matchId, originalTableId: created.tableId, originalGameId: state[0].gameId, revision: row.revision, link: row.link, oldDecision: state[1].decision, oldCursor: state[1].cursor })
    await save(fixture)
    console.log(JSON.stringify({ phase: 'prepared', matchId: row.matchId, turn: row.turn, link: row.link }))
  } else if (mode === 'idle') {
    assert.equal(process.env.PLAYMAT_PRIVATE_RESPONSE_IDLE_SECONDS, '60')
    const fixture = JSON.parse(await readFile(file, 'utf8'))
    await clients(fixture)
    let inactiveConcede = false, gameEnded = false
    browser.bus.on('CHATMESSAGE', message => { if (/has timed out .*Auto concede/.test(message?.message ?? '')) inactiveConcede = true })
    browser.bus.on('GAME_OVER', () => { gameEnded = true })
    const created = await browser.createGame({ name: 'Isolated idle acceptance', format: 'Modern', deck, matchTimeLimit: 'NONE', seed: 78 }, async record => {
      const response = await fetch(base + '/api/playtesting/invites', { method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: browser.fixtureCookie },
        body: JSON.stringify({ ...record, guestEngineName: fixture.engineName }) })
      assert.equal(response.status, 201)
      return response.json()
    })
    await call('join_game', { tableId: created.tableId, deck })
    await browser.startMatch(created.tableId)
    let pending = await until(state => state.some(s => s.status === 'active' && s.decision?.choices?.length && s.timing?.inactivity.status === 'running'), 'private own idle deadline')
    const firstIndex = pending.findIndex(s => s.status === 'active' && s.decision?.choices?.length && s.timing.inactivity.status === 'running')
    const first = pending[firstIndex]
    assert.equal(first.timing.matchClock.status, 'disabled')
    assert.equal(first.secondsRemaining, null)
    assert.ok(first.timing.inactivity.secondsRemaining > 55 && first.timing.inactivity.secondsRemaining <= 60)
    assert.equal(first.timing.inactivity.timeoutSeconds, 60, 'The real engine window duration reaches MCP independently of the balance')
    await sleep(1200)
    assert.equal(await choose(firstIndex, first, false), true)
    pending = await until(state => state.some(s => s.status === 'active' && s.decision?.choices?.length
      && s.decision.id !== first.decision.id && s.timing?.inactivity.status === 'running'), 'new accepted-response window')
    const idleIndex = pending.findIndex(s => s.status === 'active' && s.decision?.choices?.length
      && s.decision.id !== first.decision.id && s.timing.inactivity.status === 'running')
    const saved = pending[idleIndex]
    assert.equal(saved.timing.matchClock.status, 'disabled')
    assert.ok(saved.timing.inactivity.deadlineEpochMs > first.timing.inactivity.deadlineEpochMs + 500)
    assert.ok(saved.timing.inactivity.secondsRemaining > 55 && saved.timing.inactivity.secondsRemaining <= 60)
    assert.equal(saved.timing.inactivity.timeoutSeconds, 60)
    const deadline = saved.timing.inactivity.deadlineEpochMs
    const end = Date.now() + 70_000
    let polls = 0, resyncs = 0
    while (Date.now() < end && !(inactiveConcede && gameEnded)) {
      const state = await states(); polls++
      const observed = state[idleIndex]
      // Replaying an engine prompt may allocate a fresh local decision ID; its underlying deadline must not move.
      if (observed.status === 'active' && observed.gameId === saved.gameId && observed.timing?.inactivity.status === 'running') {
        assert.equal(observed.timing.inactivity.deadlineEpochMs, deadline)
        assert.equal(observed.timing.inactivity.timeoutSeconds, 60, 'Polling preserves the actual duration without resetting the deadline')
        if (polls % 3 === 0) {
          if (idleIndex === 0) await browser.resync(saved.gameId)
          else await call('resync_game', { gameId: saved.gameId })
          resyncs++
        }
      }
      await sleep(500)
    }
    assert.equal(inactiveConcede, true)
    assert.equal(gameEnded, true)
    assert.ok(polls > 50 && resyncs > 10)
    console.log(JSON.stringify({ phase: 'private-idle-expired', configuredSeconds: 60, matchClock: 'disabled', acceptedResponseReset: true, pollsDidNotRenew: true, cachedPromptResyncsDidNotRenew: true }))
  } else if (mode === 'advance') {
    const fixture = JSON.parse(await readFile(file, 'utf8'))
    await clients(fixture)
    const {row} = await playTo(9)
    await save({...fixture,revision:row.revision})
    console.log(JSON.stringify({phase:'advanced-fixture',turn:row.turn}))
  } else if (mode === 'complete') {
    const fixture = JSON.parse(await readFile(file, 'utf8'))
    await clients(fixture)
    const status = await browser.recoveryStatus(fixture.matchId)
    assert.equal(status.status, 'live')
    await browser.recoveryJoin({ matchId: fixture.matchId, revision: status.revision, agree: false })
    await call('recover_match', { matchId: fixture.matchId, revision: status.revision, agree: false })
    await until(s => s.every(x => x.gameId && x.ownHand?.length), 'both live game sessions reconnected')
    await completeMatch(fixture)
  } else if (mode === 'incompatible') {
    const fixture = JSON.parse(await readFile(file, 'utf8'))
    await clients(fixture)
    const status = await browser.recoveryStatus(fixture.matchId)
    assert.equal(status.status, 'unavailable')
    assert.equal(status.tableId, undefined)
    assert.match(status.message, /incompatible/)
    console.log(JSON.stringify({ phase: 'incompatible-rejected-before-table-load', matchId: fixture.matchId }))
  } else {
    const fixture = JSON.parse(await readFile(file, 'utf8'))
    await clients(fixture)
    const status = await browser.recoveryStatus(fixture.matchId)
    assert.equal(status.status, 'waiting')
    assert.equal(status.link, fixture.link)
    assert.equal(status.originalTableId, fixture.originalTableId)
    const publicIdentity = (await browser.recoveryList()).find(row => row.matchId === fixture.matchId)
    const third = await createProduct({ databaseUrl: process.env.DATABASE_URL })
    const otherToken = randomBytes(32).toString('base64url')
    try {
      try { await third.provisionHuman('RecoveryEve', password) } catch(e) { if(e.status!==409) throw e }
      await third.provisionAgent('RecoveryBob', 'inv_' + randomBytes(3).toString('hex'), ['play'], otherToken)
    } finally { await third.close() }
    outsider = await login('RecoveryEve', { accountId: fixture.aliceId, seatId: 'human:' + fixture.aliceId })
    await assert.rejects(() => outsider.recoveryStatus(fixture.matchId))
    await assert.rejects(() => outsider.recoveryJoin({ matchId: fixture.matchId, revision: status.revision, agree: true }))
    assert.equal((await outsider.recoveryList()).length, 0)
    otherGrant = new Client({ name: 'same-owner-unseated-grant', version: '1.0.0' })
    await otherGrant.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { fetch: fixtureMcpFetch, requestInit: { headers: { Authorization: 'Bearer ' + otherToken } } }))
    const forbidden = await otherGrant.callTool({ name: 'get_recovery_status', arguments: { matchId: fixture.matchId } })
    assert.equal(forbidden.isError, true, 'another grant owned by the same account cannot take the admitted MCP seat')
    const invite = await fetch(base + '/join/' + fixture.originalTableId, { redirect: 'manual' })
    assert.equal(invite.status, 303) // original URL still requires authentication
    const first = await browser.recoveryJoin({ matchId: fixture.matchId, revision: status.revision, agree: true })
    assert.equal(first.status, 'waiting')
    await sleep(1500)
    assert.equal((await browser.recoveryStatus(fixture.matchId)).revision, status.revision)
    assert.equal(browser.snapshot().gameId, null, 'no game or clock is created with only one agreement')
    await Promise.all([
      browser.recoveryJoin({ matchId: fixture.matchId, revision: status.revision, agree: true }),
      call('recover_match', { matchId: fixture.matchId, revision: status.revision, agree: true }),
    ])
    const restored = await browser.recoveryStatus(fixture.matchId)
    assert.equal(restored.status, 'live')
    assert.equal(restored.generation, (publicIdentity.generation ?? 0) + 1)
    assert.notEqual(restored.tableId, fixture.originalTableId)
    const repeat = await Promise.all([browser.recoveryJoin({ matchId: fixture.matchId, revision: status.revision, agree: true }), call('recover_match', { matchId: fixture.matchId, revision: status.revision, agree: true })])
    assert.ok(repeat.every(r => r.tableId === restored.tableId && r.generation === restored.generation))
    if (status.phase === 'sideboard') {
      assert.equal(restored.gameId, undefined, 'no fabricated active game during recovered sideboarding')
      await until(s => s.every(x => x.status === 'sideboarding'), 'both real sideboard prompts')
      const sideboards = [browser.sideboardState(), await call('get_sideboard_state')]
      assert.ok(sideboards.every(s => s.deck.cards.length > 0))
      assert.equal(deckSignature(sideboards[0].deck), fixture.savedSideboardDeckSignature, 'the changed submitted main/sideboard allocation survives the process restart')
      await browser.submitSideboard({ decisionId: sideboards[0].decisionId, deck: sideboards[0].deck })
      await call('submit_sideboard', { decisionId: sideboards[1].decisionId, deck: sideboards[1].deck })
      await playTo(2)
      const next = await browser.recoveryStatus(fixture.matchId)
      assert.equal(next.gameNumber, 2)
      console.log(JSON.stringify({ phase: 'sideboard-recovered-and-playing', generation: next.generation, gameNumber: next.gameNumber, turn: next.turn }))
      await completeMatch(fixture)
    } else {
      await until(s => s.every(x => x.gameId && x.ownHand?.length), 'both restored hands')
      assert.notEqual(browser.snapshot().gameId, fixture.originalGameId)
      if (fixture.oldDecision?.choices?.length) {
        const stale = await mcp.callTool({ name: 'submit_decision', arguments: { gameId: fixture.originalGameId, cursor: fixture.oldCursor,
          decisionId: fixture.oldDecision.id, choiceId: fixture.oldDecision.choices[0].id, idempotencyKey: randomUUID() } })
        assert.equal(stale.isError, true, 'the old issued decision cannot act in the recovered game')
      }
      await save({ ...fixture, restoredGameId: browser.snapshot().gameId, restoredTableId: restored.tableId })
      console.log(JSON.stringify({ phase: 'turn-recovered', generation: restored.generation, turn: restored.turn, gameNumber: restored.gameNumber }))
      if (mode === 'recover-sideboard') {
        await concedeAndWaitFor('sideboarding', 'sideboarding after recovered game')
        const sideboard = browser.sideboardState()
        const changed = structuredClone(sideboard.deck)
        const forest = changed.cards.find(card => card.cardName === 'Forest')
        const mountain = changed.sideboard.find(card => card.cardName === 'Mountain')
        assert.ok(forest.amount > 1 && mountain.amount === 1)
        forest.amount--
        changed.cards.push({ ...mountain })
        changed.sideboard = [{ ...forest, amount: 1 }]
        await browser.submitSideboard({ gameId: browser.snapshot().gameId, decisionId: sideboard.decisionId, deck: changed })
        const saved = await browser.recoveryStatus(fixture.matchId)
        assert.equal(saved.phase, 'sideboard')
        await save({ ...fixture, sideboardRevision: saved.revision, savedSideboardDeckSignature: deckSignature(changed) })
        console.log(JSON.stringify({ phase: 'durable-sideboard', gameNumber: saved.gameNumber }))
      }
    }
  }
} finally {
  browser?.close(); outsider?.close(); await mcp?.close(); await otherGrant?.close()
}
