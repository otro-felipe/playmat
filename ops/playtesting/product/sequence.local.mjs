// Opt-in real-Java fixture. Never run against a real account, database, game or public endpoint.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { createProduct } from './product.mjs'
import { PlaymatEngineSeat } from '../mcp/src/engine-seat.mjs'
import { mayDriveRival } from './sequence-driver.mjs'

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
let injectRivalMana = false, rivalManaAccepted = false
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
function cleanupMountain(state) {
  if (state.step !== 'CLEANUP' || state.decision?.kind !== 'target'
    || !/discard/i.test(state.decision.instruction ?? '')) return null
  return state.decision.choices.find(item => item.card?.name === 'Mountain'
    && state.ownHand.some(card => card.id === item.card.id && card.name === 'Mountain')) ?? null
}
async function rivalPass(boundary) {
  const state = browser.snapshot()
  if (!mayDriveRival(state, boundary)) return false
  const decision = state.decision
  if (!decision || state.status !== 'active') return false
  let choice, mana
  if (decision.kind === 'priority') {
    // Put one public mana source out before the tested line; afterwards this seat only passes.
    mana = injectRivalMana && !rivalManaAccepted && state.stack.length > 0
      && decision.choices.find(item => item.type === 'manaAbility' && item.card?.name === 'Mountain'
        && ownPlayer(state).battlefield.some(card => card.id === item.card.id && !card.tapped))
    choice = mana || !ownPlayer(state).battlefield.length && decision.choices.find(item => item.card?.name === 'Mountain'
      && state.ownHand.some(card => card.id === item.card.id))
    choice ||= decision.choices.find(item => item.type === 'pass')
  } else choice = cleanupMountain(state) || decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label)) || decision.choices.find(item => item.type === 'button')
  if (!choice) throw Error('Unexpected rival fixture decision: ' + decision.kind)
  try { await browser.respond(decision.id, choice.id); if (choice === mana) rivalManaAccepted = true; return true }
  catch (error) { if (['stale_decision', 'engine_rejected', 'illegal_choice'].includes(error.code)) return false; throw error }
}
async function playLineWithPeer(command, boundary) {
  let done = false
  const peer = (async () => {
    while (!done && Date.now() < totalDeadline) {
      await rivalPass(boundary)
      await sleep(15)
    }
  })()
  try {
    return await call('play_line', command)
  } finally {
    done = true
    await peer
  }
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
  assert.ok(discovered.tools.some(tool => tool.name === 'play_line'))
  const guideBundle = await call('get_guide', { bundle: true })
  assert.equal(guideBundle.guides.length, 4)
  assert.ok(guideBundle.guides.every(guide => guide.text?.length > 0))
  assert.ok(JSON.stringify(discovered.tools.find(tool => tool.name === 'play_sequence').inputSchema).includes('allowPlannedResolutions'))
  const created = await browser.createGame({ name: 'Isolated causal sequence acceptance', format: 'Modern', deck: rivalDeck, matchTimeLimit: 'MIN__15', seed: 77 }, async record => {
    const response = await fetch(base + '/api/playtesting/invites', { method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify({ ...record, guestEngineName: engineName }) })
    assert.equal(response.status, 201)
    return response.json()
  })
  await call('join_game', { tableId: created.tableId, deck: burnDeck })
  await browser.startMatch(created.tableId)
  let state
  let testedOwnStops = false
  while (Date.now() < totalDeadline) {
    await rivalPass()
    state = await ownState()
    if (state.status !== 'active' || !state.decision || state.decision.kind === 'waiting') { await sleep(15); continue }
    const decision = state.decision
    if (!testedOwnStops && decision.kind === 'priority' && state.priority === 'self'
      && state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === rivalPlayer(state).id
      && rivalPlayer(state).battlefield.length && rivalPlayer(state).handCount <= 7 && state.stack.length === 0) {
      const beforeDraw = state.sequenceEvidence.informationRevision
      const upkeep = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
        waitMs: 15_000, actions: [{ kind: 'pass_until', destination: 'my_upkeep', policy: 'decline_optional' }] })
      assert.equal(upkeep.status, 'completed', String(upkeep.reason))
      assert.equal(upkeep.state.step, 'UPKEEP')
      assert.equal(upkeep.state.activePlayerId, ownPlayer(upkeep.state).id)
      assert.equal(upkeep.state.sequenceEvidence.informationRevision, beforeDraw)
      assert.equal(upkeep.needsAgent, true)
      const draw = await playLineWithPeer({ gameId: state.gameId, cursor: upkeep.state.cursor, commandId: randomUUID(),
        waitMs: 15_000, actions: [{ kind: 'pass_until', destination: 'my_draw', policy: 'decline_optional' }] })
      assert.equal(draw.status, 'completed', String(draw.reason))
      assert.equal(draw.state.step, 'DRAW')
      assert.equal(draw.state.turn, upkeep.state.turn)
      assert.equal(draw.state.sequenceEvidence.informationRevision, beforeDraw + 1)
      assert.equal(draw.needsAgent, true)
      console.log(JSON.stringify({ phase: 'real-java-own-upkeep-and-draw', stoppedBeforeDraw: true, nextLineSawCommittedDraw: true }))
      testedOwnStops = true
      continue
    }
    const land = decision.kind === 'priority' && decision.choices.find(choice => choice.card?.name === 'Mountain'
      && state.ownHand.some(card => card.id === choice.card.id))
    if (land) { await answer(state, land); continue }
    if (decision.kind === 'priority' && state.priority === 'self' && state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === ownPlayer(state).id
      && burnCards(state).length >= 3 && freeLands(state).length >= 3 && rivalPlayer(state).battlefield.length > 0) break
    const discard = cleanupMountain(state)
    const choice = discard || decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label))
      || decision.choices.find(item => item.type === 'pass') || decision.choices.find(item => item.type === 'button')
    if (!choice) throw Error('Unexpected setup decision: ' + decision.kind)
    await answer(state, choice)
  }
  assert.ok(state?.step === 'PRECOMBAT_MAIN' && state.activePlayerId === ownPlayer(state).id && burnCards(state).length >= 3 && freeLands(state).length >= 3, 'Fixed-seed setup must reach three burn spells and their public mana sources')
  assert.equal(testedOwnStops, true, 'PM-LINE-02 must exercise both priority windows in real Java')
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
    learned.push({ kind: decision.kind, instruction: decision.instruction })
    await answer(state, choice)
    state = await waitNextOwn(decision.id)
  }
  assert.equal(state.stack.length, 1, 'Leave the paid warm-up spell in the initial visible stack for semantic adoption')
  const own = ownPlayer(state), rival = rivalPlayer(state)
  const cards = burnCards(state).slice(0, 2), lands = freeLands(state)
  assert.equal(cards.length, 2); assert.ok(lands.length >= 2)
  assert.ok(state.sequenceEvidence?.epoch, 'Real Java must project public causal evidence')
  const before = { life: rival.life, actions: state.sequenceEvidence.publicActions[rival.id] ?? 0,
    revision: state.sequenceEvidence.resolutionRevision, epoch: state.sequenceEvidence.epoch }
  assert.deepEqual(learned.map(item => item.kind), ['target', 'payMana'], 'The identical-cost semantic fixture must use its observed target/payment order')
  const actions = cards.map((card, index) => ({ kind: 'play', select: { cardId: card.id, zone: 'hand' },
    targets: [{ select: { objectId: rival.id }, instruction: learned[0].instruction }], payWith: [lands[index].id] }))
  assert.equal(JSON.stringify(actions).includes('pass'), false, 'The agent expresses spells, targets and resources without priority choreography')
  const boundary = { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId }
  const command = { gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(), waitMs: 15_000,
    actions: [...actions, { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' }] }
  const result = await playLineWithPeer(command, boundary)
  assert.equal(result.status, 'completed', 'The real own-damage line must retain its unapplied second spell and complete: ' + JSON.stringify({
    reason: result.reason, completedSteps: result.completedSteps, appliedDecisions: result.appliedDecisions,
  }))
  assert.equal(result.planOwnsExecution, false)
  assert.equal(result.commandId, command.commandId)
  assert.equal(result.state.gameId, state.gameId)
  assert.ok(result.appliedDecisions >= 6, 'The two plays and their mandatory choices must be acknowledged')
  const retry = await call('play_line', { ...command, waitMs: 0 })
  assert.equal(retry.sequenceId, result.sequenceId)
  assert.equal(retry.appliedDecisions, result.appliedDecisions)
  assert.equal(result.lastDestination.turn, boundary.turn)
  assert.equal(result.lastDestination.activePlayerId, boundary.activePlayerId)
  assert.equal(result.lastDestination.step, 'END_TURN', 'The receipt must prove the actual observed destination before any later engine-only auto-advance')
  const after = result.state
  assert.ok(after.turn === boundary.turn || after.turn === boundary.turn + 1, 'An empty end step can advance automatically under engine preferences; the MCP must not submit another choice')
  assert.equal(rivalPlayer(after).life, before.life - [warmup, ...cards].reduce((sum, card) => sum + (card.name === 'Lightning Bolt' ? 3 : 2), 0))
  assert.equal(after.sequenceEvidence.epoch, before.epoch)
  assert.equal(after.sequenceEvidence.publicActions[rival.id] ?? 0, before.actions, 'Open rival mana without public action does not interrupt')
  assert.equal(after.sequenceEvidence.resolutionRevision, before.revision + 3)
  assert.ok(cards.every(card => !after.ownHand.some(remaining => remaining.id === card.id)))
  // Independent second scenario: actually activate rival mana with a planned burn spell on the stack.
  // PlayerImpl's mana path emits no ACTIVATED_ABILITY rules event, so only the neutral observer can catch it.
  state = after
  while (Date.now() < totalDeadline) {
    await rivalPass()
    state = await ownState()
    if (!state.decision || state.decision.kind === 'waiting') { await sleep(15); continue }
    if (state.decision.kind === 'priority' && state.priority === 'self' && state.step === 'PRECOMBAT_MAIN'
      && state.activePlayerId === ownPlayer(state).id && burnCards(state).length && freeLands(state).length) break
    const land = state.decision.kind === 'priority' && state.decision.choices.find(item => item.card?.name === 'Mountain'
      && state.ownHand.some(card => card.id === item.card.id))
    const discard = cleanupMountain(state)
    const choice = land || discard || state.decision.choices.find(item => item.type === 'pass') || state.decision.choices.find(item => item.type === 'button')
    if (!choice) throw Error('Unplanned setup decision before rival mana scenario')
    await answer(state, choice)
  }
  assert.ok(state.step === 'PRECOMBAT_MAIN' && burnCards(state).length && freeLands(state).length)
  const reactingRival = rivalPlayer(state), reactingOwn = ownPlayer(state), reactionCard = burnCards(state)[0]
  const reactionLife = reactingRival.life, reactionActions = state.sequenceEvidence.publicActions[reactingRival.id] ?? 0
  const reactionLands = freeLands(state)
  let reactionManaIndex = 0
  const reactionSteps = [{ kind: 'answer', select: { cardId: reactionCard.id, zone: 'hand' }, guard: { kind: 'priority', step: 'PRECOMBAT_MAIN' }, expectCast: true }]
  for (const { kind, instruction } of learned) reactionSteps.push({ kind: 'answer', guard: { kind, ...(kind === 'target' ? { instruction } : {}), step: 'PRECOMBAT_MAIN' },
    select: kind === 'target' ? { label: reactingRival.name } : { cardId: reactionLands[reactionManaIndex++].id, zone: 'battlefield' } })
  reactionSteps.push({ kind: 'yield_priority', allowPlannedResolutions: true },
    { kind: 'answer', select: { label: 'Pass' }, guard: { kind: 'priority', step: 'PRECOMBAT_MAIN', priority: 'self' } })
  injectRivalMana = true
  const reactionPlan = await call('play_sequence', { gameId: state.gameId, cursor: state.cursor, steps: reactionSteps })
  let interrupted
  while (Date.now() < totalDeadline) {
    await rivalPass()
    interrupted = await call('get_sequence_status', { gameId: state.gameId, sequenceId: reactionPlan.sequenceId })
    if (interrupted.status !== 'running') break
    await sleep(15)
  }
  console.log(JSON.stringify({ phase: 'real-java-rival-response-attempt', status: interrupted?.status,
    reason: interrupted?.reason, completedSteps: interrupted?.completedSteps, appliedDecisions: interrupted?.appliedDecisions,
    rivalManaAccepted }))
  assert.equal(rivalManaAccepted, true, 'The real rival PlayerImpl mana path must have executed')
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.reason, 'opponent_action')
  assert.ok(interrupted.appliedDecisions >= 1 && interrupted.appliedDecisions < reactionSteps.length, 'Acknowledged actions remain counted and the unapplied remainder never completes')
  assert.ok(interrupted.completedSteps < reactionSteps.length)
  injectRivalMana = false
  state = await ownState()
  while (state.stack.length && Date.now() < totalDeadline) {
    await rivalPass()
    state = await ownState()
    const choice = state.decision?.kind === 'priority' && state.decision.choices.find(item => item.type === 'pass')
    if (choice) { await answer(state, choice); state = await waitNextOwn(state.decision.id) } else await sleep(15)
  }
  assert.equal(state.stack.length, 0)
  assert.equal(rivalPlayer(state).life, reactionLife - (reactionCard.name === 'Lightning Bolt' ? 3 : 2))
  assert.equal(state.sequenceEvidence.publicActions[reactingRival.id], reactionActions + 1)
  assert.equal(ownPlayer(state).id, reactingOwn.id)
  console.log(JSON.stringify({ phase: 'real-java-rival-mana-interrupted-before-next-answer', manaActionObserved: true, ownBurnSubsequentlyResolved: true }))
  console.log(JSON.stringify({ phase: 'real-java-own-damage-line-completed', completedSteps: result.completedSteps,
    appliedDecisions: result.appliedDecisions, ownResolutions: 3, initialStackAdopted: true, semanticActions: 2,
    rivalOnlyPassed: true, observedEndStep: result.lastDestination.step === 'END_TURN', setupActions: acceptedSetup }))
} finally { browser?.close(); await client?.close() }
