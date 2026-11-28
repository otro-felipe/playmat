import { expect, it } from 'vitest';
import { visibleAgentGame } from './agentChoices';
import type { GameSessionState } from './gameSession';

it('projects typed public action counters and only the current seat’s draw evidence', () => {
  const state = {
    playerId: 'pilot', view: { myPlayerId: 'pilot', sequenceEvidence: {
      spellCasts: { rival: 2 }, attackerDeclarations: { rival: 1 },
      lastDrawTurn: 3, hiddenCardId: 'private',
    } },
  } as unknown as GameSessionState;

  const projected = visibleAgentGame(state).sequenceEvidence;
  expect(projected).toMatchObject({ spellCasts: { rival: 2 }, attackerDeclarations: { rival: 1 }, lastDrawTurn: 3 });
  expect(projected).not.toHaveProperty('hiddenCardId');
  expect(visibleAgentGame({ ...state, playerId: null }).sequenceEvidence).not.toHaveProperty('lastDrawTurn');
  expect(visibleAgentGame({ ...state, playerId: 'rival' }).sequenceEvidence).not.toHaveProperty('lastDrawTurn');
});

it('distinguishes an older engine without typed evidence from a supported engine with no actions or draw', () => {
  const state = {
    playerId: 'pilot', view: { myPlayerId: 'pilot', sequenceEvidence: { epoch: 'game' } },
  } as unknown as GameSessionState;

  const oldProjection = visibleAgentGame(state).sequenceEvidence;
  expect(oldProjection).not.toHaveProperty('spellCasts');
  expect(oldProjection).not.toHaveProperty('attackerDeclarations');
  expect(oldProjection).not.toHaveProperty('lastDrawTurn');
  expect(visibleAgentGame({ ...state, view: { ...state.view, sequenceEvidence: {
    epoch: 'game', spellCasts: {}, attackerDeclarations: {}, lastDrawTurn: 0,
  } } }).sequenceEvidence).toMatchObject({ spellCasts: {}, attackerDeclarations: {}, lastDrawTurn: 0 });
});
