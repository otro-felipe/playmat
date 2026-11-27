import type { CardView, GameView, StackAbilityView } from '../../protocol/generated/views';

/** A public label only: never search hands, private viewers or a previous view's card cache. */
export function publicCardName(card: CardView): string {
  if (card.faceDown || card.hideInfo) return 'Face-down card';
  if (card.stackAbility) return card.stackAbility.source?.name ? `Ability of ${card.stackAbility.source.name}` : 'Ability';
  const source = (card as StackAbilityView).sourceCard;
  if (source) return `Ability of ${source.faceDown || source.hideInfo ? 'Face-down card' : source.displayName || source.name || 'Card'}`;
  return card.displayName || card.name || 'Card';
}

export function publicTargetLabels(card: CardView, view: GameView | null): string[] {
  const publicCards = new Map<string, CardView>(Object.entries(view?.stack ?? {}));
  for (const player of view?.players ?? []) {
    for (const zone of [player.battlefield, player.graveyard, player.exile]) {
      for (const [id, target] of Object.entries(zone ?? {})) publicCards.set(id, target);
    }
  }
  for (const zone of view?.exiles ?? []) {
    for (const [id, target] of Object.entries(zone)) publicCards.set(id, target);
  }
  return [...new Set(card.targets ?? [])].map((id) => {
    const player = view?.players?.find((candidate) => candidate.playerId === id);
    if (player) return player.name || 'Player';
    const target = publicCards.get(id);
    return target ? publicCardName(target) : 'Hidden or unavailable target';
  });
}
