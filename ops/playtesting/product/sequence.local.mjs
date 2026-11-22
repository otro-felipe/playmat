// Opt-in real-Java fixture. Never run against a real account, database, game or public endpoint.
import { fixtureGameClock } from './fixture-game-clock.mjs'
import { fixtureMcpFetch } from './fixture-mcp-fetch.mjs'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { createProduct } from './product.mjs'
import { PlaymatEngineSeat } from '../mcp/src/engine-seat.mjs'
import { mayDriveRival } from './sequence-driver.mjs'
import { verifyTypedManaTalent } from './mana-semantics.local.mjs'
import { verifyDiscardChoiceCapture, verifyHumanReplayCapture, verifyModeAndUseCapture, verifyReplayCapture } from './replay-capture.local.mjs'
import { verifyReplayReviewOverMcp } from './replay-review.local.mjs'

if (process.env.PLAYMAT_SEQUENCE_LOCAL_TEST !== 'yes'
  || !process.env.DATABASE_URL?.includes('@playmat-sequence-pg:5432/sequence_fixture')) throw Error('Explicit isolated sequence fixture required')
const base = 'http://127.0.0.1:8080'
const require = createRequire(new URL('../mcp/package.json', import.meta.url))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
const password = 'isolated-sequence-fixture-only'
const token = randomBytes(32).toString('base64url')
const engineName = 'seq_' + randomBytes(3).toString('hex')
// Each spell costs {R}, targets any target and needs no other choice on this all-Mountain battlefield.
const fixtureBurnDamage = new Map([['Lightning Bolt', 3], ['Shock', 2], ['Tarfire', 2], ['Galvanic Blast', 2], ['Wild Slash', 2]])
const burnDeck = { name: 'Isolated causal burn fixture', cards: [
  { cardName: 'Mountain', amount: 40 },
  ...Array.from(fixtureBurnDamage.keys(), cardName => ({ cardName, amount: 4 })),
], sideboard: [] }
const rivalDeck = { name: 'Isolated pass-only fixture', cards: [{ cardName: 'Mountain', setCode: 'DMU', cardNumber: '271', amount: 60 }], sideboard: [] }
const prepareDeck = { name: 'Isolated mode and prepare fixture', cards: [
  { cardName: 'Mountain', amount: 52 }, { cardName: 'Pompous Battlemage', amount: 4 }, { cardName: "Heroes' Hangout", amount: 4 },
], sideboard: [] }
let browser, client
const gameClock = fixtureGameClock()
const startFixture = gameClock.forGame(createFixture)
const startHumanReviewFixture = gameClock.forGame(createHumanReviewFixture)
let acceptedSetup = 0
let toolTrips = 0
let injectRivalMana = false, rivalManaAccepted = false
let rivalSetup
function setRivalSetup(choose) { rivalSetup = choose }
async function call(name, args = {}, measure) {
  toolTrips++
  const result = await client.callTool({ name, arguments: args })
  const responseText = result.content[0].text
  const data = responseText.startsWith('{') ? JSON.parse(responseText) : { code: 'mcp_protocol_error', message: responseText }
  if (result.isError) throw Object.assign(Error('Isolated MCP action failed: ' + name), { code: data.code })
  measure?.(Buffer.byteLength(responseText, 'utf8'))
  return data
}
async function ownState() { return call('get_game_state') }
async function comparePlayerViews(scenario, tool, args) {
  let fullBytes, compactBytes
  const fullResult = await call(tool, { ...args, view: 'full' }, bytes => { fullBytes = bytes })
  const compactResult = await call(tool, { ...args, view: 'compact' }, bytes => { compactBytes = bytes })
  const full = fullResult.state ?? fullResult
  const compact = compactResult.state ?? compactResult
  assert.equal(compact.cursor, full.cursor, 'Compare the same engine callback')
  assert.equal(compact.decision?.id, full.decision?.id)
  assert.equal(compact.priority, full.priority)
  const cards = new Map([
    ...compact.ownHand, ...compact.stack,
    ...compact.players.flatMap(player => [...player.battlefield, ...player.graveyard, ...player.exile]),
  ].map(card => [card.id, card]))
  function actionableChoices(state) {
    return state.decision?.choices.map(({ cardRef, card, ...choice }) => {
      const visible = cardRef ? cards.get(cardRef) : card
      if (cardRef) assert.ok(visible, 'Card reference resolves within this receipt')
      if (!visible) return choice
      const { hints, setCode, cardNumber, ...playable } = visible
      return { ...choice, card: hints?.length ? { ...playable, hints } : playable }
    })
  }
  assert.deepEqual(actionableChoices(compact), actionableChoices(full))
  assert.ok(compactBytes < fullBytes)
  console.log(JSON.stringify({ scenario, tool, fullBytes, compactBytes }))
  return { state: compact, choices: actionableChoices(compact) }
}
const ownPlayer = state => state.players.find(player => player.yourSeat)
const rivalPlayer = state => state.players.find(player => !player.yourSeat)
const burnCards = state => state.ownHand.filter(card => fixtureBurnDamage.has(card.name))
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
  let choice = rivalSetup?.(state), mana
  if (!choice && decision.kind === 'priority') {
    // Put one public mana source out before the tested line; afterwards this seat only passes.
    mana = injectRivalMana && !rivalManaAccepted && state.stack.length > 0
      && decision.choices.find(item => item.type === 'manaAbility' && item.card?.name === 'Mountain'
        && ownPlayer(state).battlefield.some(card => card.id === item.card.id && !card.tapped))
    choice = mana || !ownPlayer(state).battlefield.length && decision.choices.find(item => item.card?.name === 'Mountain'
      && state.ownHand.some(card => card.id === item.card.id))
    choice ||= decision.choices.find(item => item.type === 'pass')
  } else if (!choice) choice = cleanupMountain(state)
    || decision.choices.find(item => state.step === 'CLEANUP' && state.ownHand.some(card => card.id === (item.objectId ?? item.card?.id)))
    || decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label)) || decision.choices.find(item => item.type === 'button')
  if (!choice) throw Error('Unexpected rival fixture decision: ' + decision.kind + ' ' + decision.instruction)
  try { await browser.respond(decision.id, choice.id); if (choice === mana) rivalManaAccepted = true; return true }
  catch (error) { if (['stale_decision', 'engine_rejected', 'illegal_choice'].includes(error.code)) return false; throw error }
}
async function drivePeerDuring(work, boundary) {
  let done = false
  const peer = (async () => {
    while (!done && gameClock.hasTime()) {
      await rivalPass(boundary)
      await sleep(25)
    }
  })()
  try { return await Promise.race([work(), peer.then(() => new Promise(() => {}))]) }
  finally { done = true; await peer }
}
async function playLineWithPeer(command, boundary) {
  return drivePeerDuring(async () => {
    let receipt = await call('play_line', command)
    while (receipt.planOwnsExecution && gameClock.hasTime()) {
      receipt = await call('wait_for_decision', { gameId: command.gameId, commandId: command.commandId, view: command.view, timeoutMs: 5_000 })
      assert.equal(receipt.commandId, command.commandId, 'Recover the same accepted line')
    }
    assert.equal(receipt.planOwnsExecution, false, 'The isolated line must reach a terminal receipt')
    return receipt
  }, boundary)
}
async function waitNextOwn(oldId, priorGameId, expectedTableId) {
  const end = gameClock.deadlineWithin(35_000)
  let last
  while (Date.now() < end) {
    const receipt = await drivePeerDuring(() => call('wait_for_decision', { afterDecisionId: oldId, timeoutMs: 1500 }))
    const state = receipt.state ?? await ownState()
    last = [state, browser.snapshot()].map(seat => ({ status: seat.status, step: seat.step, turn: seat.turn,
      priority: seat.priority, decision: seat.decision?.kind, sameDecision: seat.decision?.id === oldId }))
    if (state.gameId !== priorGameId && (!expectedTableId || state.tableId === expectedTableId)) {
      if (state.status === 'active' && state.decision && state.decision.id !== oldId && state.decision.kind !== 'waiting') return state
      if (['game_over', 'match_over', 'sideboarding', 'disconnected'].includes(state.status)) break
    }
    if (state.gameId === priorGameId || expectedTableId && state.tableId !== expectedTableId) await sleep(100)
  }
  throw Error('No next own fixture decision: ' + JSON.stringify(last))
}
async function createFixture(name, deck, seed, opponentDeck = rivalDeck, format = 'Modern', winsNeeded = 2) {
  const priorGameId = (await ownState()).gameId
  const created = await browser.createGame({ name, format, winsNeeded, deck: opponentDeck, matchTimeLimit: 'MIN__15', seed }, async record => {
    const response = await fetch(base + '/api/playtesting/invites', { method: 'POST', headers: { 'content-type': 'application/json', Cookie: browserCookie }, body: JSON.stringify({ ...record, guestEngineName: engineName }) })
    assert.equal(response.status, 201)
    return response.json()
  })
  await call('join_game', { tableId: created.tableId, deck })
  await browser.startMatch(created.tableId)
  return waitNextOwn(undefined, priorGameId, created.tableId)
}
async function warmDeckValidation() {
  // Bridge health can precede the first fully initialized Java deck validation.
  // This read-only probe can be retried without creating or joining a table.
  for (let attempt = 0; ; attempt++) {
    try {
      const validation = await browser.validateDeck({ format: 'Modern', deck: rivalDeck })
      assert.equal(validation.valid, true)
      return
    } catch (error) {
      if (attempt >= 2 || error.message !== 'No answer from the server for deckValidate') throw error
    }
  }
}
let browserCookie

async function browserLogin(username) {
  const response = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }) })
  assert.equal(response.status, 303)
  return response.headers.get('set-cookie').split(';')[0]
}

async function createHumanReviewFixture(run) {
  const login = await browserLogin('SequenceBob')
  const peer = new PlaymatEngineSeat({ engineUrl: 'ws://127.0.0.1:8080/ws', engineName: 'SequenceBob',
    trustedHeader: 'X-Playmat-User', authenticationHeaders: { Cookie: login } })
  const name = 'Isolated automatic human replay review'
  try {
    const created = await browser.createGame({ name, format: 'Pioneer', deck: rivalDeck, matchTimeLimit: 'MIN__15', seed: 77 }, async record => {
      const response = await fetch(base + '/api/playtesting/invites', { method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: browserCookie },
        body: JSON.stringify({ ...record, guestEngineName: 'SequenceBob' }) })
      assert.equal(response.status, 201)
      return response.json()
    })
    await peer.joinGame({ tableId: created.tableId, deck: rivalDeck }, created, async () => {
      const response = await fetch(base + '/api/playtesting/invites/' + created.tableId + '/claim', {
        method: 'POST', headers: { 'content-type': 'application/json', Cookie: login }, body: '{}' })
      assert.ok(response.ok)
      return response.json()
    })
    await browser.startMatch(created.tableId)
    return await run([browser, peer])
  } finally {
    peer.close()
  }
}

async function playPreparedTurnDecisionByDecision(state, { hangoutId, actId, attackerId, lands }) {
  let castCount = 0, payments = 0
  while (gameClock.hasTime() && state.step !== 'END_TURN') {
    const decision = state.decision
    const selectObject = (choice, id) => choice.objectId === id || choice.card?.id === id
    let choice
    if (decision.kind === 'priority') {
      if (state.step === 'PRECOMBAT_MAIN' && !state.stack.length && castCount < 2) {
        choice = decision.choices.find(item => selectObject(item, [hangoutId, actId][castCount]))
        assert.ok(choice, 'The same spell is legal during the control line')
        castCount++
      } else choice = decision.choices.find(item => item.type === 'pass')
    } else if (decision.kind === 'panel') {
      choice = decision.choices.find(item => /^Patrol Night\b/.test(item.label))
    } else if (decision.kind === 'target') {
      choice = decision.choices.find(item => selectObject(item, attackerId))
        ?? decision.choices.find(item => item.intent === 'confirm_target' || /^(Done|Confirm|Skip)$/.test(item.label))
    } else if (decision.kind === 'payMana') {
      choice = decision.choices.find(item => selectObject(item, lands[payments]))
      payments++
    } else if (decision.kind === 'question') {
      choice = decision.choices.find(item => item.answer === false)
    } else if (decision.kind === 'declareAttackers') {
      choice = decision.choices.find(item => selectObject(item, attackerId)) ?? decision.choices.find(item => item.intent === 'confirm_attack')
      if (state.combat?.some(group => group.attackers?.some(({ id }) => id === attackerId))) {
        choice = decision.choices.find(item => item.intent === 'confirm_attack')
      }
    }
    assert.ok(choice, 'No equivalent control answer for ' + decision.kind + ' ' + (decision.instruction ?? ''))
    await answer(state, choice)
    state = await waitNextOwn(decision.id)
  }
  assert.equal(castCount, 2)
  assert.equal(payments, 2)
  assert.equal(state.step, 'END_TURN')
  return state
}

async function verifyPreparedModeLine(mode, verifyArchive = false) {
  let state = await startFixture('Isolated prepare and modal acceptance: ' + mode, prepareDeck, 77)
  const battlemage = state => ownPlayer(state).battlefield.find(card => card.name === 'Pompous Battlemage')
  const hangout = state => state.ownHand.find(card => card.name === "Heroes' Hangout")
  const prepared = state => ownPlayer(state).exile.find(card => card.name === 'Improvised Act')
  let battlemageCastTurn
  while (gameClock.hasTime()) {
    const decision = state.decision
    const ownMain = state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === ownPlayer(state).id && decision.kind === 'priority'
    if (ownMain && battlemage(state) && state.turn > battlemageCastTurn && hangout(state)
      && prepared(state) && freeLands(state).length >= 2 && !state.stack.length) break
    const land = ownMain && decision.choices.find(choice => choice.card?.name === 'Mountain'
      && state.ownHand.some(card => card.id === choice.card.id))
    const creature = ownMain && battlemageCastTurn === undefined && freeLands(state).length
      && decision.choices.find(choice => choice.card?.name === 'Pompous Battlemage')
    const mana = decision.kind === 'payMana' && decision.choices.find(choice => freeLands(state).some(card => card.id === choice.card?.id))
    const choice = land || creature || mana || cleanupMountain(state)
      || decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label))
      || decision.choices.find(item => item.type === 'pass') || decision.choices.find(item => item.type === 'button')
    assert.ok(choice, 'Unexpected prepare setup prompt ' + decision.kind)
    if (!land && creature) battlemageCastTurn = state.turn
    await answer(state, choice)
    state = await waitNextOwn(decision.id)
  }
  assert.ok(state.turn > battlemageCastTurn && battlemage(state) && hangout(state) && prepared(state)
    && freeLands(state).length >= 2, 'Prepared fixture setup with an attack-ready creature')
  const attacker = battlemage(state)
  const act = prepared(state)
  const lands = freeLands(state)
  const beforeLife = rivalPlayer(state).life
  const prowess = [{ sourceId: attacker.id, abilityText: 'Prowess (Whenever you cast a noncreature spell, this creature gets +1/+1 until end of turn.)' }]
  const patrol = mode !== 'Date Night'
  const hangoutAction = { kind: 'play', select: { cardId: hangout(state).id }, mode: patrol ? 'Patrol Night' : mode,
    ...(patrol ? { targets: [{ select: { objectId: attacker.id }, targetZone: 'BATTLEFIELD', role: 0 }] } : {}),
    payWith: [{ sourceId: lands[0].id, color: 'R' }], expectTriggers: prowess }
  const acceptsDiscard = mode === 'Improvised Act Yes'
  const discard = state.ownHand.find(card => card.name === 'Mountain')
  assert.ok(discard, 'The fixture keeps an expendable known card to make the Yes/No question available')
  const actActions = patrol ? [
    { kind: 'play', select: { cardId: act.id }, payWith: [{ sourceId: lands[1].id, color: 'R' }], expectTriggers: prowess },
    { kind: 'choose', guard: { kind: 'question', instruction: 'Discard a card and draw a card?' }, select: { answer: acceptsDiscard } },
    ...(acceptsDiscard ? [{ kind: 'choose', guard: { kind: 'target', instruction: 'Select a card (discard cost)' },
      select: { objectId: discard.id } }] : []),
  ] : []
  const started = performance.now()
  const startTrips = toolTrips
  if (mode === 'Low-level control') {
    const end = await playPreparedTurnDecisionByDecision(state, { hangoutId: hangout(state).id, actId: act.id, attackerId: attacker.id,
      lands: lands.map(({ id }) => id) })
    assert.equal(rivalPlayer(end).life, beforeLife - 4)
    console.log(JSON.stringify({ phase: 'PM-LINE-FLOW-1 PM-LINE-FLOW-2 real Java low-level control', mode,
      toolTrips: toolTrips - startTrips, elapsedMs: Math.round(performance.now() - started) }))
    await call('concede', { gameId: state.gameId, entireMatch: true })
    return
  }
  const receipt = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
    view: 'compact', waitMs: 15_000, actions: [
      hangoutAction, ...actActions,
      { kind: 'attack', attackers: [attacker.id] },
      { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
    ] }, { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
  const context = JSON.stringify({ reason: receipt.reason, error: receipt.error, step: receipt.state?.step,
    prompt: receipt.state?.decision?.instruction, choices: receipt.state?.decision?.choices.map(({ label }) => label), completedSteps: receipt.completedSteps })
  if (patrol && !acceptsDiscard) {
    assert.equal(receipt.status, 'completed', context)
    assert.equal(rivalPlayer(receipt.state).life, beforeLife - 4, 'Patrol Night and two Prowess triggers give four damage')
    assert.equal(receipt.lastDestination.step, 'END_TURN')
  } else {
    assert.equal(receipt.status, 'interrupted', context)
    assert.equal(receipt.reason, 'new_information', context)
    assert.ok(receipt.appliedDecisions >= 3, 'The engine cast the selected mode before stopping at its information boundary')
    assert.equal(rivalPlayer(receipt.state).life, beforeLife, 'An information-changing branch cannot execute the queued attack')
    assert.equal(receipt.state.step, 'PRECOMBAT_MAIN')
  }
  console.log(JSON.stringify({ phase: 'PM-LINE-FLOW-1 PM-LINE-FLOW-2 real Java', mode,
    status: receipt.status, toolTrips: toolTrips - startTrips, appliedDecisions: receipt.appliedDecisions, elapsedMs: Math.round(performance.now() - started) }))
  await call('concede', { gameId: state.gameId, entireMatch: true })
  if (verifyArchive) await verifyModeAndUseCapture(state.gameId, gameClock)
}
const scenarios = process.env.PLAYMAT_SEQUENCE_SCENARIOS
try {
  const product = await createProduct({ databaseUrl: process.env.DATABASE_URL })
  try {
    await product.provisionHuman('SequenceAlice', password)
    await product.provisionHuman('SequenceBob', password)
    const withReview = ['review', 'review-prepared'].includes(scenarios)
    await product.provisionAgent('SequenceBob', engineName, withReview ? ['play', 'history'] : ['play'], token)
  } finally { await product.close() }
  browserCookie = await browserLogin('SequenceAlice')
  browser = new PlaymatEngineSeat({ engineUrl: 'ws://127.0.0.1:8080/ws', engineName: 'SequenceAlice', trustedHeader: 'X-Playmat-User', authenticationHeaders: { Cookie: browserCookie } })
  await browser.open()
  client = new Client({ name: 'isolated-real-sequence-fixture', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { fetch: fixtureMcpFetch, requestInit: { headers: { Authorization: 'Bearer ' + token } } }))
  const discovered = await client.listTools()
  assert.ok(discovered.tools.some(tool => tool.name === 'advance_to_own_turn'))
  assert.ok(discovered.tools.some(tool => tool.name === 'play_line'))
  const viewTools = ['get_game_state', 'play_line', 'wait_for_decision'].map(name => discovered.tools.find(tool => tool.name === name))
  assert.ok(viewTools.every(tool => tool?.inputSchema.properties.view), 'Native catalog exposes compact state through every line entry point')
  const lineTools = JSON.stringify(viewTools.map(({ name, inputSchema }) => ({ name, inputSchema })))
  assert.ok(['modeId', 'payWith', 'assignments', 'targetRole', 'expectAbility', 'activate', 'adoptTriggerOrder'].every(field => lineTools.includes('"' + field + '"')))
  console.log(JSON.stringify({ phase: 'PM-LINE-MCP-2 real native discovery', version: client.getServerVersion()?.version,
    lineSchemaSha256: createHash('sha256').update(lineTools).digest('hex') }))
  const guideBundle = await call('get_guide', { bundle: true })
  assert.equal(guideBundle.guides.length, 4)
  assert.ok(guideBundle.guides.every(guide => guide.text?.length > 0))
  assert.ok(JSON.stringify(discovered.tools.find(tool => tool.name === 'play_sequence').inputSchema).includes('allowPlannedResolutions'))
  await warmDeckValidation()
  const fixture = { startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn,
    playLineWithPeer, drivePeerDuring, call, gameClock, setRivalSetup }
  const pioneerScenarios = [
    ['mulligan', './london-mulligan.local.mjs', 'verifyLondonMulligan'],
    ['line-waits', './london-mulligan.local.mjs', 'verifyLineWaits'],
    ['casting', './casting-and-order.local.mjs', 'verifyCastingCosts'],
    ['labeled-questions', './casting-and-order.local.mjs', 'verifyLabeledQuestions'],
    ['order', './casting-and-order.local.mjs', 'verifyTriggerOrder'],
    ['visible-response', './casting-and-order.local.mjs', 'verifyVisibleResponse'],
    ['card-to-step', './casting-and-order.local.mjs', 'verifyCardToStep'],
    ['activation', './creature-land-activation.local.mjs', 'verifyCreatureLandActivation'],
    ['combat', './combat-destinations.local.mjs', 'verifyPlaneswalkerCombat'],
    ['saga-entry', './saga-entry.local.mjs', 'verifySagaEntry'],
    ['exile', './combat-exile.local.mjs', 'verifyCombatExile'],
    ['ward', './multi-target-ward.local.mjs', 'verifyMultiTargetWard'],
  ]
  const pioneer = pioneerScenarios.find(([name]) => name === scenarios)
  if (scenarios === 'review') {
    const capture = await verifyReplayCapture({ startFixture, call, ownPlayer, rivalPlayer, answer, waitNextOwn, gameClock })
    const humanCapture = await verifyHumanReplayCapture({ startHumanReviewFixture, gameClock })
    await verifyReplayReviewOverMcp({ capture, humanCapture, Client, StreamableHTTPClientTransport, token })
  } else if (scenarios === 'discard-capture') {
    await verifyDiscardChoiceCapture(fixture)
  } else if (scenarios === 'review-prepared') {
    // This line also verifies mode/use evidence in the archived replay using the history grant.
    await verifyPreparedModeLine('Patrol Night', true)
  } else if (pioneer) {
    const [, modulePath, run] = pioneer
    await (await import(modulePath))[run](fixture)
  } else if (scenarios === 'date-night') {
    await verifyPreparedModeLine('Date Night')
  } else if (scenarios === 'improvised-yes') {
    await verifyPreparedModeLine('Improvised Act Yes')
  } else if (scenarios === 'low-level-control') {
    await verifyPreparedModeLine('Low-level control')
  } else if (scenarios === 'typed') {
    await verifyTypedManaTalent({ startFixture, ownPlayer, answer, waitNextOwn, playLineWithPeer, call, gameClock })
  } else if (scenarios === 'causal') {
    await verifyCausalBurn()
  } else throw Error('Select a real-engine family using verify-sequence-image.sh')

} finally { browser?.close(); await client?.close() }

async function verifyCausalBurn() {
  let state = await startFixture('Isolated causal sequence acceptance', burnDeck, 77)
  let testedOwnStops = false
  let testedLandIntent = false
  while (gameClock.hasTime()) {
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
    if (land) {
      if (testedLandIntent) await answer(state, land)
      else {
        assert.equal(land.canPlayLand, true, 'Java must publish a legal land choice for this exact object')
        const result = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
          actions: [{ kind: 'play', playAs: 'land', select: { objectId: land.objectId, zone: 'hand' } }] },
        { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
        assert.equal(result.status, 'completed', String(result.reason))
        assert.equal(result.appliedDecisions, 1)
        assert.ok(ownPlayer(result.state).battlefield.some(card => card.id === land.objectId))
        testedLandIntent = true
        console.log(JSON.stringify({ phase: 'real-java-typed-land', playedDeclaredObject: true }))
      }
      continue
    }
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
  assert.equal(testedLandIntent, true, 'PM-LINE-01 must use the legal land metadata in real Java')
  // Learn target/payment prompt order with one real identical-cost burn spell. Never infer missing callbacks.
  const warmup = burnCards(state)[0]
  const compactPriority = await comparePlayerViews('priority_with_cast_and_mana', 'get_game_state', { gameId: state.gameId })
  const warmupChoice = compactPriority.choices.find(choice => choice.card?.id === warmup.id)
  assert.ok(warmupChoice)
  const warmupCommand = { gameId: compactPriority.state.gameId, cursor: compactPriority.state.cursor, commandId: randomUUID(),
    actions: [{ kind: 'choose', decisionId: compactPriority.state.decision.id, choiceId: warmupChoice.id }] }
  const warmupReceipt = await call('play_line', { ...warmupCommand, view: 'compact' })
  assert.equal(warmupReceipt.appliedDecisions, 1)
  const learned = []
  state = await waitNextOwn(state.decision.id)
  assert.equal(state.decision.kind, 'target', 'Compare retained command receipts while the target prompt holds play')
  await comparePlayerViews('retained_target_line', 'play_line', { ...warmupCommand, waitMs: 0 })
  await comparePlayerViews('retained_target_command_wait', 'wait_for_decision', { gameId: warmupCommand.gameId, commandId: warmupCommand.commandId })
  for (;;) {
    const decision = state.decision
    if (decision.kind === 'priority') break
    const prompt = await comparePlayerViews(decision.kind, 'wait_for_decision', { gameId: state.gameId })
    let choice
    if (decision.kind === 'target') choice = prompt.choices.find(item => item.id === 'object-' + rivalPlayer(state).id || item.label === rivalPlayer(state).name)
    else if (decision.kind === 'payMana') choice = prompt.choices.find(item => freeLands(state).some(land => land.id === item.card?.id))
    if (!choice) throw Error('Unplanned warm-up prompt: ' + decision.kind)
    learned.push({ kind: prompt.state.decision.kind, instruction: prompt.state.decision.instruction })
    await answer(prompt.state, choice)
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
  assert.equal(rivalPlayer(after).life, before.life - [warmup, ...cards].reduce((sum, card) => sum + fixtureBurnDamage.get(card.name), 0))
  assert.equal(after.sequenceEvidence.epoch, before.epoch)
  assert.equal(after.sequenceEvidence.publicActions[rival.id] ?? 0, before.actions, 'Open rival mana without public action does not interrupt')
  assert.equal(after.sequenceEvidence.resolutionRevision, before.revision + 3)
  assert.ok(cards.every(card => !after.ownHand.some(remaining => remaining.id === card.id)))
  // Independent second scenario: actually activate rival mana with a planned burn spell on the stack.
  // PlayerImpl's mana path emits no ACTIVATED_ABILITY rules event, so only the neutral observer can catch it.
  state = after
  while (gameClock.hasTime()) {
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
  while (gameClock.hasTime()) {
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
  while (state.stack.length && gameClock.hasTime()) {
    await rivalPass()
    state = await ownState()
    const choice = state.decision?.kind === 'priority' && state.decision.choices.find(item => item.type === 'pass')
    if (choice) { await answer(state, choice); state = await waitNextOwn(state.decision.id) } else await sleep(15)
  }
  assert.equal(state.stack.length, 0)
  assert.equal(rivalPlayer(state).life, reactionLife - fixtureBurnDamage.get(reactionCard.name))
  assert.equal(state.sequenceEvidence.publicActions[reactingRival.id], reactionActions + 1)
  assert.equal(ownPlayer(state).id, reactingOwn.id)
  console.log(JSON.stringify({ phase: 'real-java-rival-mana-interrupted-before-next-answer', manaActionObserved: true, ownBurnSubsequentlyResolved: true }))
  console.log(JSON.stringify({ phase: 'real-java-own-damage-line-completed', completedSteps: result.completedSteps,
    appliedDecisions: result.appliedDecisions, ownResolutions: 3, initialStackAdopted: true, semanticActions: 2,
    rivalOnlyPassed: true, observedEndStep: result.lastDestination.step === 'END_TURN', setupActions: acceptedSetup }))
}
