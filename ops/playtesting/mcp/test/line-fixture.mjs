import assert from 'node:assert/strict';
import { GameSeat } from '../src/game-seat.mjs';

const pilot = { id: 'pilot', yourSeat: true, battlefield: [], handCount: 2 };
const rival = { id: 'rival', battlefield: [], handCount: 2, libraryCount: 40 };
const pass = { id: 'pass', type: 'pass' };
const priority = (id, ...choices) => ({ id, kind: 'priority', choices: [pass, ...choices] });
const selection = (id, card) => ({ id, objectId: card.id, type: 'object', card });
const evidence = { epoch: 'effect-fixture', publicActions: {}, resolutions: {}, resolutionRevision: 0,
  informationRevision: 0, combatRevision: 0, combatDamage: [] };
const resolved = (id, informationRevision = 0) => ({ ...evidence, resolutions: { [id]: 1 },
  resolutionRevision: 1, informationRevision });
async function execute(t, initial, transitions, actions, expectedStackIds) {
  let state = { gameId: 'effect-fixture', cursor: 1, epoch: 1, status: 'active', turn: 5,
    activePlayer: 'Pilot', activePlayerId: pilot.id, priority: 'self', step: 'PRECOMBAT_MAIN',
    players: [pilot, rival], stack: [], ownHand: [], sequenceEvidence: evidence, ...initial };
  const listeners = new Set();
  const applied = [];
  const seat = new GameSeat({
    snapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async respond(decisionId, choiceId, value) {
      assert.ok(transitions[decisionId], 'Unexpected engine action: ' + decisionId);
      applied.push([decisionId, choiceId]);
      const transition = transitions[decisionId];
      const result = typeof transition === 'function' ? transition(choiceId, value) : transition;
      for (const frame of Array.isArray(result) ? result : [result]) {
        state = { ...state, ...frame, cursor: state.cursor + 1 };
        for (const listener of [...listeners]) listener();
      }
      return { submitted: true };
    },
  }, { sequenceTimeoutMs: 250, maxSequenceWallMs: 1000 });
  t.after(() => seat.invalidate());
  const { sequenceId } = seat.startTurn({ gameId: state.gameId, cursor: state.cursor,
    actions, expectedStackIds, settle: false, finish: 'none' }, async () => true);
  const receipt = await seat.waitSequenceStatus({ gameId: state.gameId, sequenceId }, 500);
  return { receipt, applied, state };
}

export { evidence, execute, pilot, priority, resolved, rival, selection };
