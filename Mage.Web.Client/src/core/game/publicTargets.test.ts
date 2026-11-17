import { describe, expect, test } from 'vitest';
import { publicTargetLabels } from './publicTargets';
import type { GameView } from '../../protocol/generated/views';

describe('[READ-AC-001] public stack targets', () => {
  const view: GameView = {
    players: [{ playerId: 'rival', name: 'Bob', battlefield: { bear: { name: 'Runeclaw Bear' }, morph: { name: 'Secret creature', faceDown: true } }, graveyard: { dead: { name: 'Grizzly Bears' } } }],
    myHand: { secret: { name: 'Private hand card' } },
    stack: { spell: { name: 'Lightning Bolt' } },
    exiles: [{ exiled: { name: 'Exiled secret', hideInfo: true } }],
  };

  test('labels players, permanents, graveyards and other spells before they resolve', () => {
    expect(publicTargetLabels({ targets: ['rival', 'bear', 'dead', 'spell', 'bear'] }, view)).toEqual(['Bob', 'Runeclaw Bear', 'Grizzly Bears', 'Lightning Bolt']);
  });

  test('never names private, face-down, hidden or missing objects', () => {
    const labels = publicTargetLabels({ targets: ['secret', 'morph', 'exiled', 'missing'] }, view);
    expect(labels).toEqual(['Hidden or unavailable target', 'Face-down card', 'Face-down card', 'Hidden or unavailable target']);
    expect(labels.join()).not.toMatch(/Private|Secret|Exiled|missing/);
    expect(publicTargetLabels({}, view)).toEqual([]);
  });
});
