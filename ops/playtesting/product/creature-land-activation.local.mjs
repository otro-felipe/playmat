import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const scenarios = [
  { landName: 'Mutavault', setCode: 'M14', cardNumber: '228', format: 'Pioneer' },
  { landName: "Mishra's Factory", setCode: 'MH2', cardNumber: '302', format: 'Modern' },
  { landName: 'Mutavault', setCode: 'M14', cardNumber: '228', format: 'Pioneer', rivalResponse: true },
]

export async function verifyCreatureLandActivation({ startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn,
  playLineWithPeer, call, gameClock, setRivalSetup }) {
  for (const { landName, setCode, cardNumber, format, rivalResponse } of scenarios) {
    const deck = { name: 'Isolated creature land fixture', cards: [
      { cardName: landName, setCode, cardNumber, amount: 4 },
      { cardName: 'Mountain', setCode: 'DMU', cardNumber: '271', amount: 56 },
    ], sideboard: [] }
    let state = await startFixture('Isolated activation of ' + landName, deck, 77, undefined, format)
    let playedLandTurn
    let source, mountain, activation
    while (gameClock.hasTime()) {
      const own = ownPlayer(state)
      const { decision } = state
      const ownMain = state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === own.id && decision.kind === 'priority'
      source = own.battlefield.find(({ name }) => name === landName)
      mountain = own.battlefield.find(({ name, tapped }) => name === 'Mountain' && !tapped)
      if (ownMain && source && mountain && state.turn > playedLandTurn && !state.stack.length
        && (!rivalResponse || rivalPlayer(state).battlefield.some(({ name, tapped }) => name === 'Mountain' && !tapped))) {
        const legal = decision.choices.find(({ objectId }) => objectId === source.id)
        const animations = legal?.nonManaAbilities?.filter(({ abilityText }) => /\bbecomes a 2\/2\b/i.test(abilityText))
        assert.equal(animations?.length, 1, 'A unique legal animation has a full source-named rule')
        activation = animations[0]
        assert.ok(activation.abilityId && source.rules.includes(activation.abilityText))
        break
      }

      const canPlay = (name) => decision.choices.find(({ objectId, canPlayLand }) =>
        canPlayLand && state.ownHand.some((card) => card.name === name && card.id === objectId))
      const playCreatureLand = ownMain && !source && canPlay(landName)
      const playMountain = ownMain && !mountain && canPlay('Mountain')
      const discardMountain = state.step === 'CLEANUP' && decision.kind === 'target'
        && decision.choices.find(({ card }) => card?.name === 'Mountain' && state.ownHand.some(({ id }) => id === card.id))
      // London bottoms happen before the next keep prompt. Redraw at seven or six
      // when the fixture land is missing; every seven contains at least three Mountains.
      const redraw = decision.kind === 'mulligan' && state.ownHand.length > 5
        && !state.ownHand.some(card => card.name === landName)
        && decision.choices.find(choice => /^Mulligan\b/i.test(choice.label))
      const bottom = decision.kind === 'mulliganBottom' && decision.choices.find(choice =>
        state.ownHand.some(card => card.id === (choice.objectId ?? choice.card?.id) && card.name === 'Mountain'))
      const choice = playCreatureLand || playMountain || discardMountain || redraw || bottom
        || decision.choices.find(({ label }) => /^Keep\b|^Play first\b/.test(label))
        || decision.choices.find(({ type }) => type === 'pass')
      assert.ok(choice, 'Unexpected creature-land setup prompt ' + decision.kind)
      try {
        await answer(state, choice)
        if (playCreatureLand) playedLandTurn = state.turn
      } catch (error) {
        if (!['not_actionable', 'stale_decision'].includes(error.code)) throw error
      }
      state = await waitNextOwn(decision.id)
    }
    assert.ok(activation && source && mountain, 'The fixture reached an attack-ready creature land')
    const rival = rivalPlayer(state)
    const rivalActionsBefore = state.sequenceEvidence.publicActions[rival.id] ?? 0
    let rivalAttempted = false
    if (rivalResponse) {
      setRivalSetup((peer) => {
        if (rivalAttempted || peer.decision?.kind !== 'priority'
          || !peer.stack.some(({ sourceId, abilityType }) => sourceId === source.id && abilityType === 'ACTIVATED_NONMANA')) return
        const mana = peer.decision.choices.find(({ objectId, type }) => type === 'manaAbility'
          && ownPlayer(peer).battlefield.some(({ id, name, tapped }) => id === objectId && name === 'Mountain' && !tapped))
        if (mana) rivalAttempted = true
        return mana
      })
    }
    try {
      const compact = await call('get_game_state', { gameId: state.gameId, view: 'compact' })
      const payment = compact.decision.choices.find(option => option.objectId === mountain.id)
        ?.payWithOptions?.find(option => option.color === 'R')
      assert.ok(payment?.abilityId && payment.sourceId === mountain.id, 'The Mountain exposes its own exact red payment before animation')
      const animate = { kind: 'activate', sourceId: source.id, abilityId: activation.abilityId, abilityText: activation.abilityText }
      const rejected = await call('play_line', { gameId: state.gameId, cursor: compact.cursor, commandId: randomUUID(),
        view: 'compact', actions: [{ ...animate, payWith: [payment, 'absent-fixture-source'] }] })
      assert.deepEqual([rejected.status, rejected.code, rejected.appliedDecisions, rejected.state.cursor],
        ['rejected', 'source_unavailable', 0, compact.cursor])
      assert.deepEqual(rejected.issues[0].path, ['actions', 0, 'payWith', 1])
      const result = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
        view: 'compact', waitMs: 15_000, actions: [
          { ...animate, payWith: [payment] },
          { kind: 'attack', attackers: [source.id] },
          { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
        ] }, { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
      const context = JSON.stringify({ status: result.status, reason: result.reason, error: result.error,
        actionIndex: result.actionIndex, step: result.state?.step, prompt: result.state?.decision?.kind,
        completedSteps: result.completedSteps, appliedDecisions: result.appliedDecisions })
      if (rivalResponse) {
        assert.equal(rivalAttempted, true, context)
        assert.equal(result.status, 'interrupted', context)
        assert.equal(result.reason, 'opponent_action', context)
        assert.equal(result.state.sequenceEvidence.publicActions[rival.id], rivalActionsBefore + 1)
        assert.equal(rivalPlayer(result.state).life, rival.life, 'The queued attack did not run')
      } else {
        assert.equal(result.status, 'completed', context)
        assert.equal(result.lastDestination.step, 'END_TURN')
        assert.equal(result.state.stack.length, 0)
        assert.equal(ownPlayer(result.state).battlefield.find(({ id }) => id === mountain.id)?.tapped, true)
        assert.ok(ownPlayer(result.state).battlefield.find(({ id }) => id === source.id)?.types.includes('CREATURE'))
        assert.equal(rivalPlayer(result.state).life, rival.life - 2)
      }
      console.log(JSON.stringify({ phase: 'PM-LINE-SEM-5 real XMage creature-land activation', landName, format,
        rivalResponse: !!rivalResponse, status: result.status, appliedDecisions: result.appliedDecisions }))
    } finally {
      if (rivalResponse) setRivalSetup(undefined)
    }
    await call('concede', { gameId: state.gameId, entireMatch: true })
  }
}
