import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

const pass = { id: 'pass', type: 'pass' };
const priority = (id, card) => ({ id, kind: 'priority', choices: [pass, ...(card ? [{ id: `cast-${card.id}`, type: 'object', card }] : [])] });
const evidence = (actions = 0, resolutions = {}, revision = 0, epoch = 'feed-1') => ({ epoch, publicActions: { me: 0, them: actions }, resolutions, resolutionRevision: revision });
const bolt = { id: 'bolt', cardId: 'physical-bolt', name: 'Lightning Bolt', types: ['INSTANT'] };
const spike = { id: 'spike', cardId: 'physical-spike', name: 'Lava Spike', types: ['SORCERY'] };

async function run(t, variant) {
  const listeners = new Set();
  let state = { gameId: 'damage', status: 'active', epoch: 1, cursor: 1, turn: 3,
    activePlayer: 'Pilot', activePlayerId: 'me', priority: 'self', step: 'PRECOMBAT_MAIN', stack: [],
    ownHand: [bolt, spike], players: [{ id: 'me', yourSeat: true, battlefield: [] }, { id: 'them', life: 20, battlefield: [{ id: 'rival-land', tapped: false }] }],
    sequenceEvidence: evidence(), decision: priority('cast-bolt', bolt) };
  const applied = [];
  const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const fn of [...listeners]) fn(); };
  const engine = { snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    respond: async (id, choice) => {
      applied.push([id, choice]);
      if (id === 'cast-bolt') update({ ownHand: [spike], stack: [{ ...bolt, id: 'stack-bolt', controllerId: 'me' }], decision: priority('yield-bolt') });
      else if (id === 'yield-bolt') {
        const ev = variant === 'missing' ? undefined : variant === 'epoch' ? evidence(0, { 'stack-bolt': 1 }, 1, 'feed-2')
          : variant === 'gap' ? evidence(0, { 'stack-bolt': 34 }, 34) : evidence(variant === 'rival-action' ? 1 : 0, { 'stack-bolt': 1 }, 1);
        update({ sequenceEvidence: ev, players: [state.players[0], { ...state.players[1], life: 17, ...(variant === 'effect-tap' ? { battlefield: [{ id: 'rival-land', tapped: true }] } : variant === 'effect-destroy' ? { battlefield: [] } : variant === 'effect-discard' ? { handCount: 1, graveyard: [{ id: 'public-discard', name: 'Mountain' }] } : {}) }],
          ...(variant === 'mid-resolution' ? {} : { stack: variant === 'unexpected-stack' ? [{ id: 'enemy-trigger', controllerId: 'them' }] : [] }),
          decision: variant === 'unexpected-prompt' ? { id: 'target', kind: 'target', choices: [{ id: 'unplanned-target', type: 'object' }] } : priority('cast-spike', spike) });
        if (variant === 'mid-resolution') update({ stack: [] });
      } else if (id === 'cast-spike') update({ ownHand: [], stack: [{ ...spike, id: 'stack-spike', controllerId: 'me' }], decision: priority(variant === 'full-turn' ? 'yield-spike' : 'end') });
      else if (id === 'yield-spike') update({ stack: [], sequenceEvidence: evidence(0, { 'stack-bolt': 1, 'stack-spike': 2 }, 2), players: [state.players[0], { ...state.players[1], life: 14 }], decision: priority('advance-end') });
      else if (id === 'advance-end') update({ step: 'END_TURN', decision: priority('end') });
      else assert.fail('No unapplied remainder may run after an interruption');
      return { submitted: true };
    } };
  const seat = new GameSeat(engine);
  t.after(() => seat.invalidate());
  const plan = seat.startSequence({ gameId: state.gameId, cursor: 1, steps: [
    { kind: 'answer', decisionId: 'cast-bolt', choiceId: 'cast-bolt', expectCast: true },
    { kind: 'yield_priority', allowPlannedResolutions: true },
    { kind: 'answer', select: { cardId: 'spike', zone: 'hand' }, guard: { kind: 'priority', step: 'PRECOMBAT_MAIN' }, expectCast: true },
    ...(variant === 'full-turn' ? [{ kind: 'yield_priority', allowPlannedResolutions: true }, { kind: 'pass_until', step: 'END_TURN' }] : []),
  ] }, async () => true);
  for (let i = 0; i < 50; i++) {
    const status = seat.sequenceStatus({ gameId: state.gameId, sequenceId: plan.sequenceId });
    if (status.status !== 'running') return { status, applied, state };
    await sleep(2);
  }
  assert.fail('The sequence must reach a bounded terminal state');
}

for (const variant of ['damage', 'mid-resolution', 'effect-tap', 'effect-destroy']) test(`OWN-DAMAGE-REGRESSION planned damage continues to the next spell with explicit resolution evidence: ${variant}`, async (t) => {
  const { status, applied, state } = await run(t, variant);
  assert.equal(status.status, 'completed');
  assert.equal(status.completedSteps, 3);
  assert.equal(status.appliedDecisions, 3);
  assert.equal(state.players[1].life, 17);
  assert.deepEqual(applied, [['cast-bolt', 'cast-bolt'], ['yield-bolt', 'pass'], ['cast-spike', 'cast-spike']]);
});
test('[PM-AC-09-TURN] a planned discard still stops when it reveals a previously hidden opponent card', async (t) => {
  const { status, applied } = await run(t, 'effect-discard');
  assert.equal(status.status, 'interrupted'); assert.equal(status.reason, 'new_information');
  assert.deepEqual(applied, [['cast-bolt', 'cast-bolt'], ['yield-bolt', 'pass']], 'The second spell must remain unapplied after learning the discarded identity');
});
for (const variant of ['rival-action', 'missing', 'epoch', 'gap', 'unexpected-prompt', 'unexpected-stack']) test(`planned damage never hides ${variant}`, async (t) => {
  const { status, applied } = await run(t, variant);
  assert.equal(status.status, 'interrupted');
  assert.equal(status.appliedDecisions, 2, 'Already acknowledged cast and pass remain counted');
  assert.equal(applied.length, 2, 'The second spell remains unapplied');
  assert.notEqual(status.reason, null);
});

test('the complete planned turn continues through own damage while the rival retains open mana and only passes', async (t) => {
  const { status, applied, state } = await run(t, 'full-turn');
  assert.equal(status.status, 'completed');
  assert.equal(status.completedSteps, 5);
  assert.equal(status.appliedDecisions, 5);
  assert.equal(state.step, 'END_TURN');
  assert.equal(state.players[1].life, 14);
  assert.equal(state.players[1].battlefield[0].tapped, false);
  assert.deepEqual(applied.map(([id]) => id), ['cast-bolt', 'yield-bolt', 'cast-spike', 'yield-spike', 'advance-end']);
});
