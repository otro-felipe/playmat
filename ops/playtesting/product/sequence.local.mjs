// Opt-in real-Java fixture. Never run against a real account, database, game or public endpoint.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { createProduct } from './product.mjs'
import { PlaymatEngineSeat } from '../mcp/src/engine-seat.mjs'

if (process.env.PLAYMAT_SEQUENCE_LOCAL_TEST !== 'yes'
  || !process.env.DATABASE_URL?.includes('@playmat-sequence-pg:5432/sequence_fixture')) throw Error('Explicit isolated sequence fixture required')
const base = 'http://127.0.0.1:8080'
const require = createRequire(new URL('../mcp/package.json', import.meta.url))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
const password = 'isolated-sequence-fixture-only'
const token = randomBytes(32).toString('base64url')
const engineName = 'seq_' + randomBytes(3).toString('hex')
const burnDeck = { name: 'Isolated causal burn fixture', cards: [
  { cardName: 'Mountain', amount: 52 }, { cardName: 'Lightning Bolt', amount: 4 }, { cardName: 'Shock', amount: 4 },
], sideboard: [] }
const rivalDeck = { name: 'Isolated pass-only fixture', cards: [{ cardName: 'Mountain', amount: 60 }], sideboard: [] }
let browser, client
const totalDeadline = Date.now() + 300_000
let acceptedSetup = 0
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  const data = JSON.parse(result.content[0].text)
  if (result.isError) throw Object.assign(Error('Isolated MCP action failed: ' + name), { code: data.code })
  return data
}
async function ownState() { return call('get_game_state') }
const ownPlayer = state => state.players.find(player => player.yourSeat)
const rivalPlayer = state => state.players.find(player => !player.yourSeat)
const burnCards = state => state.ownHand.filter(card => /^(Lightning Bolt|Shock)$/.test(card.name))
const freeLands = state => ownPlayer(state).battlefield.filter(card => card.name === 'Mountain' && !card.tapped)
async function answer(state, choice) {
  await call('submit_decision', { gameId: state.gameId, cursor: state.cursor, decisionId: state.decision.id,
    choiceId: choice.id, idempotencyKey: randomUUID() })
  acceptedSetup++
}
async function rivalPass() {
  const state = browser.snapshot()
  const decision = state.decision
  if (!decision || state.status !== 'active') return false
  let choice
  if (decision.kind === 'priority') {
    // Put one public mana source out before the tested line; afterwards this seat only passes.
    choice = !ownPlayer(state).battlefield.length && decision.choices.find(item => item.card?.name === 'Mountain'
      && state.ownHand.some(card => card.id === item.card.id))
    choice ||= decision.choices.find(item => item.type === 'pass')
  } else choice = decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label)) || decision.choices.find(item => item.type === 'button')
  if (!choice) throw Error('Unexpected rival fixture decision: ' + decision.kind)
  try { await browser.respond(decision.id, choice.id); return true }
  catch (error) { if (['stale_decision', 'engine_rejected', 'illegal_choice'].includes(error.code)) return false; throw error }
}
async function waitNextOwn(oldId) {
  while (Date.now() < totalDeadline) {
    await rivalPass()
    const state = await ownState()
    if (state.status === 'active' && state.decision && state.decision.id !== oldId && state.decision.kind !== 'waiting') return state
    await sleep(15)
  }
  throw Error('No next own fixture decision before the bounded deadline')
}
try {
  const product = await createProduct({ databaseUrl: process.env.DATABASE_URL })
  try {
    await product.provisionHuman('SequenceAlice', password)
    await product.provisionHuman('SequenceBob', password)
    await product.provisionAgent('SequenceBob', engineName, ['play'], token)
  } finally { await product.close() }
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'SequenceAlice', password }) })
  assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  browser = new PlaymatEngineSeat({ engineUrl: 'ws://127.0.0.1:8080/ws', engineName: 'SequenceAlice', trustedHeader: 'X-Playmat-User', authenticationHeaders: { Cookie: cookie } })
  await browser.open()
  client = new Client({ name: 'isolated-real-sequence-fixture', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }))
  const discovered = await client.listTools()
  assert.ok(discovered.tools.some(tool => tool.name === 'advance_to_own_turn'))
  assert.ok(JSON.stringify(discovered.tools.find(tool => tool.name === 'play_sequence').inputSchema).includes('allowPlannedResolutions'))
  const created = await browser.createGame({ name: 'Isolated causal sequence acceptance', format: 'Modern', deck: rivalDeck, matchTimeLimit: 'MIN___15', seed: 77 }, async record => {
    const response = await fetch(base + '/api/playtesting/invites', { method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify({ ...record, guestEngineName: engineName }) })
    assert.equal(response.status, 201)
    return response.json()
  })
  await call('join_game', { tableId: created.tableId, deck: burnDeck })
  await browser.startMatch(created.tableId)
  let state
  while (Date.now() < totalDeadline) {
    await rivalPass()
    state = await ownState()
    if (state.status !== 'active' || !state.decision || state.decision.kind === 'waiting') { await sleep(15); continue }
    const decision = state.decision
    const land = decision.kind === 'priority' && decision.choices.find(choice => choice.card?.name === 'Mountain'
      && state.ownHand.some(card => card.id === choice.card.id))
    if (land) { await answer(state, land); continue }
    if (decision.kind === 'priority' && state.activePlayerId === ownPlayer(state).id
      && burnCards(state).length >= 3 && freeLands(state).length >= 3 && rivalPlayer(state).battlefield.length > 0) break
    const discard = decision.kind === 'target' && decision.choices.find(choice => choice.card?.name === 'Mountain')
    const choice = discard || decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label))
      || decision.choices.find(item => item.type === 'pass') || decision.choices.find(item => item.type === 'button')
    if (!choice) throw Error('Unexpected setup decision: ' + decision.kind)
    await answer(state, choice)
  }
  assert.ok(state?.activePlayerId === ownPlayer(state).id && burnCards(state).length >= 3 && freeLands(state).length >= 3, 'Fixed-seed setup must reach three burn spells and their public mana sources')
  // Learn target/payment prompt order with one real identical-cost burn spell. Never infer missing callbacks.
  const warmup = burnCards(state)[0]
  const warmupChoice = state.decision.choices.find(choice => choice.card?.id === warmup.id)
  assert.ok(warmupChoice)
  await answer(state, warmupChoice)
  const learned = []
  state = await waitNextOwn(state.decision.id)
  for (;;) {
    const decision = state.decision
    if (decision.kind === 'priority') break
    let choice
    if (decision.kind === 'target') choice = decision.choices.find(item => item.id === 'object-' + rivalPlayer(state).id || item.label === rivalPlayer(state).name)
    else if (decision.kind === 'payMana') choice = decision.choices.find(item => freeLands(state).some(land => land.id === item.card?.id))
    if (!choice) throw Error('Unplanned warm-up prompt: ' + decision.kind)
    learned.push(decision.kind)
    await answer(state, choice)
    state = await waitNextOwn(decision.id)
  }
  while (state.stack.length) {
    const choice = state.decision.choices.find(item => item.type === 'pass')
    assert.ok(choice, 'Warm-up resolution requires ordinary priority')
    await answer(state, choice)
    state = await waitNextOwn(state.decision.id)
  }
  const own = ownPlayer(state), rival = rivalPlayer(state)
  const cards = burnCards(state).slice(0, 2), lands = freeLands(state)
  assert.equal(cards.length, 2); assert.ok(lands.length >= 2)
  assert.ok(state.sequenceEvidence?.epoch, 'Real Java must project public causal evidence')
  const before = { life: rival.life, actions: state.sequenceEvidence.publicActions[rival.id] ?? 0,
    revision: state.sequenceEvidence.resolutionRevision, epoch: state.sequenceEvidence.epoch }
  let manaIndex = 0
  const steps = []
  for (const card of cards) {
    steps.push({ kind: 'answer', select: { cardId: card.id, zone: 'hand' }, guard: { kind: 'priority', step: 'PRECOMBAT_MAIN', priority: 'self' }, expectCast: true })
    for (const kind of learned) steps.push({ kind: 'answer', guard: { kind, step: 'PRECOMBAT_MAIN' },
      select: kind === 'target' ? { label: rival.name } : { cardId: lands[manaIndex++].id, zone: 'battlefield' } })
    steps.push({ kind: 'yield_priority', allowPlannedResolutions: true })
  }
  steps.push({ kind: 'pass_until', step: 'END_TURN', skipOptionalResponses: true })
  assert.ok(steps.length <= 12, 'Learned concrete line must fit the public step budget')
  const plan = await call('play_sequence', { gameId: state.gameId, cursor: state.cursor, steps })
  let result
  while (Date.now() < totalDeadline) {
    await rivalPass()
    result = await call('get_sequence_status', { gameId: state.gameId, sequenceId: plan.sequenceId })
    if (result.status !== 'running') break
    await sleep(15)
  }
  assert.equal(result.status, 'completed', 'The real own-damage line must retain its unapplied second spell and complete')
  assert.equal(result.completedSteps, steps.length)
  const after = await ownState()
  assert.equal(after.step, 'END_TURN')
  assert.equal(rivalPlayer(after).life, before.life - cards.reduce((sum, card) => sum + (card.name === 'Lightning Bolt' ? 3 : 2), 0))
  assert.equal(after.sequenceEvidence.epoch, before.epoch)
  assert.equal(after.sequenceEvidence.publicActions[rival.id] ?? 0, before.actions, 'Open rival mana without public action does not interrupt')
  assert.equal(after.sequenceEvidence.resolutionRevision, before.revision + 2)
  assert.ok(cards.every(card => !after.ownHand.some(remaining => remaining.id === card.id)))
  console.log(JSON.stringify({ phase: 'real-java-own-damage-line-completed', completedSteps: result.completedSteps,
    appliedDecisions: result.appliedDecisions, ownResolutions: 2, rivalOnlyPassed: true, endedAtEndStep: true, setupActions: acceptedSetup }))
} finally { browser?.close(); await client?.close() }
