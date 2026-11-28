import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';
import { playLine, waitForLine } from '../src/line-runtime.mjs';
import { evidence, pilot, priority, rival } from './line-fixture.mjs';

const gameId = 'clock-game';
const commandId = 'clock-line';
const authorize = async () => true;
const keep = { id: 'keep', kind: 'mulligan', choices: [{ id: 'keep-seven', type: 'button', label: 'Keep' }] };
const land = { id: 'basic', name: 'Mountain', types: ['LAND'] };
const landPlay = { kind: 'play', playAs: 'land', select: { objectId: land.id, zone: 'hand' } };
const keepThenLand = [{ kind: 'choose', decisionId: keep.id, choiceId: keep.choices[0].id }, landPlay];

function clockFixture(t, initial, respond) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const listeners = new Set();
  let state = { gameId, cursor: 1, epoch: 1, status: 'active', turn: 4, step: 'PRECOMBAT_MAIN',
    activePlayer: 'Pilot', activePlayerId: pilot.id, priority: 'self', decision: priority('main'),
    players: [pilot, rival], sequenceEvidence: evidence, stack: [], ownHand: [], ...initial };
  const applied = [];
  function update(patch) {
    state = { ...state, ...patch, cursor: state.cursor + 1 };
    for (const listener of [...listeners]) listener();
  }
  const seat = new GameSeat({
    snapshot: () => state,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    async respond(decisionId, choiceId) {
      applied.push([decisionId, choiceId]);
      await respond?.(decisionId, update);
      return { submitted: true };
    },
  });
  t.after(() => seat.invalidate());
  return {
    applied, update,
    start: (actions, waitMs) => playLine(seat, { gameId, cursor: 1, commandId, actions, waitMs }, authorize),
    wait: timeoutMs => waitForLine(seat, { gameId, commandId, timeoutMs }),
    advance: async ms => { t.mock.timers.tick(ms); await nextTurn(); },
  };
}

for (const mode of ['initial-wait', 'receipt-and-wait']) {
  test(`[PM-LINE-WAIT-1] ${mode} reaches the same destination on its callback`, async t => {
    const f = clockFixture(t, { priority: 'opponent', decision: null });
    const start = Date.now();
    const first = f.start([{ kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' }],
      mode === 'initial-wait' ? 25_000 : 0);
    let terminal = first;
    if (mode === 'receipt-and-wait') {
      const initial = await first;
      assert.equal(initial.planOwnsExecution, true);
      assert.equal(initial.needsAgent, false);
      assert.equal(initial.waitingFor, 'opponent');
      assert.equal(Date.now() - start, 0);
      terminal = f.wait(25_000);
    }
    await f.advance(12_000);
    f.update({ step: 'END_TURN', priority: 'self', decision: priority('end') });
    const receipt = await terminal;
    assert.equal(Date.now() - start, 12_000);
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.lastDestination.step, 'END_TURN');
    assert.equal(receipt.planOwnsExecution, false);
    assert.equal(receipt.needsAgent, true);
    assert.equal(receipt.waitingFor, null);
    assert.deepEqual(receipt.executionTime, { activeMs: 0, opponentPriorityMs: 12_000, openingTurnMs: 0 });
    await f.advance(500);
    assert.deepEqual((await f.wait(0)).executionTime, receipt.executionTime);
    assert.equal(receipt.appliedDecisions, 0);
    assert.deepEqual(f.applied, []);
  });
}

test('[PM-LINE-WAIT-1] a terminal pass keeps command ownership after a rival action until the seat can act', async t => {
  const f = clockFixture(t, { priority: 'opponent', decision: null });
  const first = await f.start([{ kind: 'pass_until', destination: 'end_step' }], 0);
  assert.equal(first.waitingFor, 'opponent');
  let result;
  const wait = f.wait(25_000).then(receipt => { result = receipt; });
  await f.advance(400);
  f.update({ sequenceEvidence: { ...evidence, publicActions: { [rival.id]: 1 } } });
  await nextTurn();
  assert.equal(result, undefined, 'The pass keeps waiting without reopening the decision loop');
  f.update({ priority: 'self', decision: priority('rival-response', { id: 'response', type: 'object' }) });
  await wait;
  assert.equal(result.reason, 'opponent_action');
  assert.equal(result.waitingFor, null);
  assert.equal(result.needsAgent, true);
  assert.equal(result.planOwnsExecution, false);
  assert.deepEqual(f.applied, []);
});

const opening = { turn: 0, step: null, priority: 'none', ownHand: [land], decision: keep };
for (const outcome of ['land', 'bottom', 'starting-player', 'rival-first', 'first-draw']) {
  test(`[PM-LINE-WAIT-2] accepted Keep survives a slow opening and respects ${outcome}`, async t => {
    const f = clockFixture(t, opening, (decisionId, update) => {
      if (decisionId === keep.id) update({ decision: null });
      if (decisionId === 'first-main') update({ ownHand: [], players: [{ ...pilot, battlefield: [land] }, rival],
        decision: priority('after-land') });
    });
    const first = await f.start(keepThenLand, 0);
    await nextTurn();
    await f.advance(75_000);
    const running = await f.wait(0);
    assert.equal(running.sequenceId, first.sequenceId);
    assert.equal(running.status, 'running');
    assert.equal(running.waitingFor, 'opening_turn');
    assert.equal(running.appliedDecisions, 1);
    const wait = f.wait(25_000);
    if (outcome === 'land') {
      f.update({ turn: 1, step: 'PRECOMBAT_MAIN', priority: 'self', decision: priority('first-main',
        { id: 'play-land', type: 'object', objectId: land.id, card: land, canPlayLand: true }) });
    } else if (outcome === 'bottom') {
      f.update({ decision: { id: 'bottom', kind: 'mulliganBottom', choices: [{ id: 'choose-card' }] } });
    } else if (outcome === 'starting-player') {
      f.update({ priority: 'opponent', decision: { id: 'first', kind: 'startingPlayer', choices: [{ id: 'play-first' }] } });
    } else if (outcome === 'rival-first') {
      f.update({ turn: 1, step: 'UPKEEP', activePlayer: 'Rival', activePlayerId: rival.id, priority: 'opponent', decision: null });
    } else {
      f.update({ turn: 1, step: 'DRAW', priority: 'self', decision: priority('after-draw'),
        ownHand: [land, { id: 'drawn', name: 'Island' }], sequenceEvidence: { ...evidence, informationRevision: 1 } });
    }
    const result = await wait;
    assert.equal(result.status, outcome === 'land' ? 'completed' : 'interrupted');
    const reasons = { bottom: 'response_available', 'starting-player': 'response_available',
      'rival-first': 'turn_changed', 'first-draw': 'new_information' };
    if (outcome !== 'land') assert.equal(result.reason, reasons[outcome]);
    assert.equal(result.planOwnsExecution, false);
    assert.equal(result.needsAgent, outcome !== 'rival-first');
    assert.deepEqual(result.executionTime, { activeMs: 0, opponentPriorityMs: 0, openingTurnMs: 75_000 });
    assert.equal(result.waitingFor, null);
    assert.deepEqual(f.applied, outcome === 'land'
      ? [['keep', 'keep-seven'], ['first-main', 'play-land']] : [['keep', 'keep-seven']]);
  });
}

test('[PM-LINE-WAIT-2] absent priority without an accepted Keep still charges active time', async t => {
  const f = clockFixture(t, { ...opening, decision: null });
  await f.start([landPlay], 0);
  await nextTurn();
  assert.equal((await f.wait(0)).waitingFor, null);
  await f.advance(60_001);
  const result = await f.wait(0);
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(f.applied, []);
});

test('[PM-LINE-WAIT-2] a stopped peer after Keep cannot retain the executor beyond its wall lifetime', async t => {
  const f = clockFixture(t, opening, (_id, update) => update({ decision: null }));
  await f.start(keepThenLand, 0);
  await nextTurn();
  await f.advance(899_999);
  assert.equal((await f.wait(0)).waitingFor, 'opening_turn');
  await f.advance(1);
  const result = await f.wait(0);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reason, 'timeout');
  assert.deepEqual(f.applied, [['keep', 'keep-seven']]);
});

for (const changedEpoch of [false, true]) {
  test(`[PM-LINE-WAIT-2] late Keep acknowledgement after ${changedEpoch ? 'epoch change' : 'active timeout'} cannot authorize the land`, async t => {
    const ack = Promise.withResolvers();
    const f = clockFixture(t, opening, async (_id, update) => { update({ decision: null }); await ack.promise; });
    await f.start(keepThenLand, 0);
    await f.advance(60_005);
    const before = await f.wait(0);
    assert.equal(before.waitingFor, null);
    assert.equal(before.executionTime.activeMs, 60_005);
    if (changedEpoch) f.update({ epoch: 2 });
    ack.resolve();
    await nextTurn();
    const terminal = await f.wait(0);
    assert.equal(terminal.reason, changedEpoch ? 'invalidated' : 'timeout');
    assert.deepEqual(terminal.executionTime, { activeMs: 60_005, opponentPriorityMs: 0, openingTurnMs: 0 });
    assert.deepEqual(f.applied, [['keep', 'keep-seven']]);
  });
}

test('[PM-LINE-WAIT-1] an idle peer keeps ordinary priority beyond the active cap and repeated submission recovers the same command', async t => {
  const f = clockFixture(t, { priority: 'opponent', decision: null });
  const actions = [{ kind: 'pass_until', destination: 'end_step' }];
  const first = await f.start(actions, 0);
  await f.advance(164_800);
  const running = await f.start(actions, 0);
  assert.equal(running.sequenceId, first.sequenceId);
  assert.equal(running.waitingFor, 'opponent');
  assert.equal(running.status, 'running');
  assert.equal(running.executionTime.opponentPriorityMs, 164_800);
  f.update({ step: 'END_TURN', priority: 'self', decision: priority('end') });
  await nextTurn();
  assert.equal((await f.wait(0)).status, 'completed');
  assert.deepEqual(f.applied, []);
});
