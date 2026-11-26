import { describe, expect, it } from 'vitest';
import type { GameView } from '../../protocol/generated/views';
import type { EventBus } from '../rpc/EventBus';
import { GameSession } from './gameSession';
import { describeAgentDecision, projectedChoices } from './agentChoices';

type Handler = (data: unknown, event: { objectId: string | null }) => void;

function session() {
  const handlers = new Map<string, Handler[]>();
  const bus = {
    on(method: string, handler: Handler) {
      handlers.set(method, [...(handlers.get(method) ?? []), handler]);
      return () => undefined;
    },
  } as unknown as EventBus;
  const emit = (method: string, data: unknown) => handlers.get(method)?.forEach((handler) => handler(data, { objectId: 'g1' }));
  return { game: new GameSession({} as never, bus, { gameId: 'g1', playerId: 'me', mode: 'play' }), emit };
}

const card = 'card-emptiness';
const spell = 'spell-emptiness';
const view = {
  myPlayerId: 'me', turn: 6, step: 'PRECOMBAT_MAIN', myHand: {},
  stack: { [spell]: { id: spell, cardId: card, name: 'Emptiness', cardTypes: ['CREATURE'] } },
  players: [{ playerId: 'me', name: 'Pilot', battlefield: {} }],
} as unknown as GameView;

function decision(keyChoices: Record<string, string>, hintData: Record<string, string[]>, required = false) {
  const { game, emit } = session();
  emit('GAME_CHOOSE_CHOICE', { gameView: view, choice: { message: 'You may choose an alternative cost', required, keyChoices, hintData } });
  return describeAgentDecision(projectedChoices(game.getState(), 'prompt'));
}

describe('agent projection of the alternative cost chooser', () => {
  it('names Evoke and the normal cast and binds them to the spell being cast', () => {
    const projected = decision({
      1: 'Cast with Evoke alternative cost: {W/B}{W/B} (source: Emptiness [car])',
      2: 'Cast with no alternative cost: {4}{W/B}{W/B}',
    }, { 1: ['GAME_OBJECT', card], 2: ['GAME_OBJECT', spell] });
    expect(projected).toMatchObject({ kind: 'panel', castCostPicker: true, sourceObjectId: card });
    expect(projected?.choices.filter((choice) => choice.type === 'option').map((choice) => choice.castCost)).toEqual(['Evoke', 'none']);
  });

  it('names an unnamed required alternative cost without a normal option', () => {
    const projected = decision({ 1: 'Cast with alternative cost: {0} (source: Emptiness [car])' }, { 1: ['GAME_OBJECT', card] }, true);
    expect(projected).toMatchObject({ castCostPicker: true, sourceObjectId: card });
    expect(projected?.choices.map((choice) => choice.castCost)).toEqual(['alternative']);
  });

  it('leaves other choice lists and hidden sources untouched', () => {
    const colors = decision({ 1: 'Red', 2: 'Blue' }, {});
    expect(colors).not.toHaveProperty('castCostPicker');
    expect(colors?.choices.some((choice) => 'castCost' in choice)).toBe(false);
    const hidden = decision({ 1: 'Cast with no alternative cost: {2}' }, { 1: ['GAME_OBJECT', 'not-visible'] });
    expect(hidden).not.toHaveProperty('castCostPicker');
  });
});
