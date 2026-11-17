import type { CardView, GameView } from '../../protocol/generated/views';

export interface StackTargetConnection {
  sourceId: string;
  targetIds: string[];
  depth: number;
  emphasis: 'top' | 'focused' | 'waiting';
  /** Cards below the top of a public pile connect to that pile when they have no individual board element. */
  targetAnchors?: Record<string, string>;
}

/** Connect only to objects in public zones, even if private cards happen to have DOM elements. */
export function stackTargetConnections(items: readonly CardView[], view: GameView | null, focusId: string | null, selected: ReadonlySet<string>, choosingSource: string | null): StackTargetConnection[] {
  const publicIds = new Set(Object.keys(view?.stack ?? {}));
  const piles: Record<string, string> = {};
  for (const player of view?.players ?? []) {
    if (player.playerId) publicIds.add(player.playerId);
    for (const zone of [player.battlefield, player.graveyard, player.exile]) {
      Object.keys(zone ?? {}).forEach((id) => publicIds.add(id));
    }
    for (const id of Object.keys(player.graveyard ?? {})) piles[id] = `graveyard:${player.playerId}`;
    for (const id of Object.keys(player.exile ?? {})) piles[id] = `exile:${player.playerId}`;
  }
  for (const zone of view?.exiles ?? []) Object.keys(zone).forEach((id) => publicIds.add(id));
  return items.flatMap((card, depth) => {
    if (!card.id || card.id === choosingSource) return [];
    const targetIds = [...new Set(card.targets ?? [])].filter((id) => publicIds.has(id));
    const targetAnchors = Object.fromEntries(targetIds.filter((id) => piles[id]).map((id) => [id, piles[id]]));
    return targetIds.length ? [{ sourceId: card.id, targetIds, depth, emphasis: focusId === card.id || selected.has(card.id) ? 'focused' as const : depth === 0 ? 'top' as const : 'waiting' as const,
      ...(Object.keys(targetAnchors).length ? { targetAnchors } : {}),
    }] : [];
  });
}

export interface ArrowPoint { x: number; y: number }

/** Fan both the bend and the endpoint so shared targets never collapse into a single line. */
export function stackTargetCurve(from: ArrowPoint, to: ArrowPoint, depth: number, branch: number): { path: string; end: ArrowPoint } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const lane = Math.atan(depth + branch * 0.4) * 22;
  const end = { x: to.x - dx / distance * 24 - dy / distance * lane, y: to.y - dy / distance * 24 + dx / distance * lane };
  const control = { x: (from.x + end.x) / 2, y: Math.min(from.y, end.y) - Math.abs(dx) * 0.16 - 55 - Math.min(depth, 6) * 42 - Math.min(branch, 6) * 18 };
  return { path: `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`, end };
}
