import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const deck = {
  name: 'London mulligan fixture',
  cards: [{ cardName: 'Forest', setCode: 'DMU', cardNumber: '281', amount: 60 }],
  sideboard: [],
};

async function startOpening({ startFixture, answer, waitNextOwn, setRivalSetup }, onPlay) {
  const firstChoice = ownFirst => ownFirst ? 'Play first' : 'Draw first';
  setRivalSetup(state => state.decision.kind === 'startingPlayer'
    ? state.decision.choices.find(choice => choice.label === firstChoice(!onPlay)) : undefined);
  try {
    let state = await startFixture('Isolated London mulligan', deck, 77, undefined, 'Pioneer');
    if (state.decision.kind === 'startingPlayer') {
      const choice = state.decision.choices.find(option => option.label === firstChoice(onPlay));
      assert.ok(choice);
      await answer(state, choice);
      state = await waitNextOwn(state.decision.id);
    }
    assert.equal(state.decision.kind, 'mulligan');
    return state;
  } finally {
    setRivalSetup(null);
  }
}

export async function verifyLondonMulligan(fixture) {
  const { waitNextOwn, playLineWithPeer, call, answer, ownPlayer } = fixture;
  for (const redraws of [1, 2]) {
    let state = await startOpening(fixture, true);
    const answered = new Set();
    const steps = [];
    async function choose(kind, choice) {
      const { gameId, cursor, decision } = state;
      assert.equal(decision.kind, kind);
      assert.ok(choice, 'The current decision offers the required legal choice');
      assert.ok(!answered.has(decision.id), 'Each response uses a fresh prompt');
      answered.add(decision.id);
      steps.push(kind === 'mulliganBottom' ? 'bottom' : choice.label.split(' ')[0]);
      const receipt = await playLineWithPeer({ gameId, cursor, commandId: randomUUID(),
        actions: [{ kind: 'choose', decisionId: decision.id, choiceId: choice.id }],
      });
      assert.equal(receipt.appliedDecisions, 1, receipt.reason ?? receipt.code);
      state = receipt.state;
      if (!state.decision || state.decision.kind === 'waiting' || state.decision.id === decision.id) {
        state = await waitNextOwn(decision.id);
      }
    }

    for (let round = 1; round <= redraws; round++) {
      await choose('mulligan', state.decision.choices.find(choice => /^Mulligan\b/i.test(choice.label)));
      assert.equal(state.ownHand.length, 7);
      for (let bottom = 0; bottom < round; bottom++) {
        const selected = state.decision.choices.find(choice =>
          state.ownHand.some(card => card.id === (choice.objectId ?? choice.card?.id)));
        assert.ok(selected, 'Bottom an exact visible card from the new hand');
        const selectedId = selected.objectId ?? selected.card.id;
        const remaining = state.ownHand.map(card => card.id).filter(id => id !== selectedId);
        await choose('mulliganBottom', selected);
        assert.deepEqual(new Set(state.ownHand.map(card => card.id)), new Set(remaining));
      }
    }
    const kept = state.ownHand.map(card => card.id);
    assert.equal(kept.length, 7 - redraws);
    await choose('mulligan', state.decision.choices.find(choice => /^Keep\b/i.test(choice.label)));
    assert.equal(state.turn, 1);
    assert.deepEqual(new Set(state.ownHand.map(card => card.id)), new Set(kept));
    console.log(JSON.stringify({ scenario: 'London mulligan', redraws, steps, openingHandSize: kept.length }));
    await call('concede', { gameId: state.gameId, entireMatch: true });
  }

  const guide = await call('get_guide', { guideId: 'turn-planning' });
  const example = [...guide.text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, body]) => JSON.parse(body))
    .find(command => command.commandId === 'opening-land-after-bottom');
  assert.ok(example, 'Use the published bottom, guarded Keep and land line');
  for (const onPlay of [true, false]) {
    let state = await startOpening(fixture, onPlay);
    const mulligan = state.decision.choices.find(choice => choice.label === 'Mulligan');
    assert.ok(mulligan);
    await answer(state, mulligan);
    state = await waitNextOwn(state.decision.id);
    assert.equal(state.decision.kind, 'mulliganBottom');
    const [bottomed, land] = state.ownHand;
    const bottom = state.decision.choices.find(choice => (choice.objectId ?? choice.card?.id) === bottomed.id);
    assert.ok(bottom);
    const [bottomAction, keepAction, landAction] = example.actions;
    const receipt = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
      actions: [
        { ...bottomAction, decisionId: state.decision.id, choiceId: bottom.id },
        keepAction,
        { ...landAction, select: { ...landAction.select, objectId: land.id } },
      ],
    });
    const { state: final } = receipt;
    const context = JSON.stringify({ status: receipt.status, reason: receipt.reason, completedSteps: receipt.completedSteps,
      appliedDecisions: receipt.appliedDecisions, decision: final.decision?.kind, instruction: final.decision?.instruction });
    assert.equal(final.turn, 1, context);
    assert.equal(final.activePlayerId === ownPlayer(final).id, onPlay);
    assert.ok(!final.ownHand.some(card => card.id === bottomed.id));
    if (onPlay) {
      assert.equal(receipt.status, 'completed', context);
      const landCardId = land.cardId ?? land.id;
      assert.ok(landCardId && ownPlayer(final).battlefield.some(card => card.cardId === landCardId), 'Play the specified copy');
      assert.equal(final.ownHand.length, 5);
    } else {
      assert.equal(receipt.reason, 'turn_changed', context);
      assert.equal(receipt.appliedDecisions, 2);
      assert.ok(final.ownHand.some(card => card.id === land.id));
      assert.equal(final.ownHand.length, 6);
      assert.equal(ownPlayer(final).battlefield.length, 0);
    }
    console.log(JSON.stringify({ scenario: 'Bottom, Keep and land', onPlay, status: receipt.status, reason: receipt.reason,
      startingHandSize: 6, landPlayed: onPlay, appliedDecisions: receipt.appliedDecisions }));
    await call('concede', { gameId: state.gameId, entireMatch: true });
  }

}

// Same seed, on-play seat and authorized line. Only the HTTP response budget changes.
export async function verifyLineWaits(fixture) {
  const { call, drivePeerDuring, ownPlayer } = fixture;
  for (const waitMs of [25_000, 0]) {
    const state = await startOpening(fixture, true);
    const keep = state.decision.choices.find(choice => choice.label === 'Keep');
    const land = state.ownHand[0];
    assert.ok(keep && land);
    const commandId = randomUUID();
    const request = { gameId: state.gameId, cursor: state.cursor, commandId, waitMs, view: 'compact', actions: [
      { kind: 'choose', decisionId: state.decision.id, choiceId: keep.id },
      { kind: 'play', playAs: 'land', select: { zone: 'hand', objectId: land.id } },
      { kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' },
    ] };
    const started = performance.now();
    let firstMs;
    const firstCall = call('play_line', request).then(receipt => {
      firstMs = Math.round(performance.now() - started);
      return receipt;
    });
    // Hold only the synthetic peer. An initial long wait and an in-flight command
    // wait both have the opportunity to return early when Java reaches the boundary.
    await new Promise(resolve => setTimeout(resolve, 350));
    let waitCalls = 0;
    const terminal = await drivePeerDuring(async () => {
      let receipt = await firstCall;
      if (!waitMs) {
        assert.equal(receipt.planOwnsExecution, true);
        assert.equal(receipt.commandId, commandId);
        waitCalls++;
        receipt = await call('wait_for_decision', { gameId: state.gameId, commandId, timeoutMs: 25_000, view: 'compact' });
      }
      return receipt;
    });
    assert.equal(terminal.status, 'completed', terminal.reason);
    assert.equal(terminal.commandId, commandId);
    assert.equal(terminal.lastDestination.step, 'END_TURN');
    assert.equal(terminal.state.turn, 1);
    assert.equal(terminal.needsAgent, true);
    assert.equal(terminal.waitingFor, null);
    assert.equal(ownPlayer(terminal.state).battlefield.length, 1);
    console.log(JSON.stringify({ scenario: 'PM-LINE-WAIT-1', initialWaitMs: waitMs, waitCalls, firstReceiptMs: firstMs,
      elapsedMs: Math.round(performance.now() - started), executionTime: terminal.executionTime,
      destination: terminal.lastDestination.step, appliedDecisions: terminal.appliedDecisions }));
    await call('concede', { gameId: state.gameId, entireMatch: true });
  }
}
