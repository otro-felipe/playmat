import { describe, expect, test } from 'vitest';
import { stackTargetConnections, stackTargetCurve } from './stackTargetArrows';
import type { CardView, GameView } from '../../protocol/generated/views';

describe('[READ-AC-004] whole-stack connections', () => {
  const items: CardView[] = [
    { id: 'fork', name: 'Electrolyze', targets: ['doge', 'bear', 'doge'] },
    { id: 'burst', name: 'Burst Lightning', targets: ['doge'] },
    { id: 'counter', name: 'Counterspell', targets: ['burst'] },
  ];
  const view: GameView = { stack: Object.fromEntries(items.map((card) => [card.id!, card])), players: [{ playerId: 'doge', name: 'Doge', battlefield: { bear: { name: 'Bear' } } }], myHand: { secret: { name: 'Secret card' } } };

  test('keeps lower spells and their multiple/shared targets with a hierarchy independent of colour', () => {
    expect(stackTargetConnections(items, view, null, new Set(), null)).toEqual([
      { sourceId: 'fork', targetIds: ['doge', 'bear'], depth: 0, emphasis: 'top' },
      { sourceId: 'burst', targetIds: ['doge'], depth: 1, emphasis: 'waiting' },
      { sourceId: 'counter', targetIds: ['burst'], depth: 2, emphasis: 'waiting' },
    ]);
    expect(stackTargetConnections(items, view, 'burst', new Set(), null).map((item) => item.emphasis)).toEqual(['top', 'focused', 'waiting']);
    expect(stackTargetConnections(items, view, null, new Set(['counter']), null)[2].emphasis).toBe('focused');
  });

  test('excludes private endpoints, replaces the chooser’s announced branch and removes departed objects', () => {
    expect(stackTargetConnections([{ ...items[0], targets: ['secret', 'missing', 'doge'] }], view, null, new Set(), null)[0].targetIds).toEqual(['doge']);
    expect(stackTargetConnections(items, view, null, new Set(), 'fork').map((item) => item.sourceId)).toEqual(['burst', 'counter']);
    expect(stackTargetConnections(items.slice(1), view, null, new Set(), null).map((item) => item.sourceId)).toEqual(['burst', 'counter']);
  });

  test('fans curves and endpoints for shared targets while keeping arrowheads close to the target', () => {
    const from = { x: 800, y: 500 };
    const to = { x: 200, y: 100 };
    const paths = [0, 1, 2].map((depth) => stackTargetCurve(from, to, depth, 0));
    expect(new Set(paths.map((item) => item.path)).size).toBe(3);
    expect(new Set(paths.map((item) => JSON.stringify(item.end))).size).toBe(3);
    expect(stackTargetCurve(from, to, 1, 1).path).not.toBe(paths[1].path);
    const deep = stackTargetCurve(from, to, 100, 0).end;
    expect(Math.hypot(deep.x - to.x, deep.y - to.y)).toBeLessThan(45);
  });

  test('gives public graveyard and exile targets a pile anchor without exposing private cards', () => {
    const next: GameView = { players: [{ playerId: 'doge', graveyard: { dead: { name: 'Grizzly Bears' } }, exile: { exiled: { name: 'Face-down', faceDown: true } } }] };
    const result = stackTargetConnections([{ id: 'spell', targets: ['dead', 'exiled', 'secret'] }], next, null, new Set(), null);
    expect(result[0].targetIds).toEqual(['dead', 'exiled']);
    expect(result[0].targetAnchors).toEqual({ dead: 'graveyard:doge', exiled: 'exile:doge' });
  });
});
