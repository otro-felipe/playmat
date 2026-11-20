import type { CardView, GameView } from '../../protocol/generated/views';

/**
 * Cards revealed from a player's hand stay known while they stay in that hand. The server lists reveals in
 * `GameView.revealed` only for the rest of the turn, each card with the zone it was revealed from (never where it is
 * now), and sends an opponent's hand as a count, so the client keeps what it saw: a card revealed from the hand, by
 * its physical card id, until it shows up anywhere public (cast, discarded, exiled, played).
 *
 * When the hand shrinks by more cards than showed up in public zones (one went back to the library, was exiled face
 * down, or was shuffled away), which ones left is unknown, and all of them are forgotten. So is everything when the
 * hand holds fewer cards than are remembered. A forgotten card is not picked up again from a reveal that is still
 * listed. Nothing that was not revealed is ever remembered; a reveal without a zone gives nothing to remember.
 */
export interface RevealedHand {
  /** revealed cards still in the hand, by physical card id (cardId, else id), in the order they were revealed */
  cards: ReadonlyMap<string, CardView>;
  handCount: number;
  /** this player's cards in public zones, by physical card id: what the hand can lose without a secret */
  inPublic: ReadonlySet<string>;
  /** reveal entries already invalidated by a card leaving the hand */
  forgotten: ReadonlySet<string>;
}

/** by player id */
export type RevealedHands = ReadonlyMap<string, RevealedHand>;

export const NO_REVEALED_HANDS: RevealedHands = new Map();

function physicalId(card: CardView, fallback: string): string {
  return card.cardId ?? card.id ?? fallback;
}

/** The memory after one more game view. */
export function rememberRevealedHands(previous: RevealedHands, view: GameView): RevealedHands {
  // every card in a public zone (none of them is in a hand), and whose each one is
  const seen = new Map<string, string | undefined>();
  const addSeen = (cards: Record<string, CardView> | undefined) => {
    for (const [id, card] of Object.entries(cards ?? {})) seen.set(physicalId(card, id), card.ownerId);
  };
  addSeen(view.stack);
  for (const zone of view.exiles ?? []) addSeen(zone);
  for (const player of view.players ?? []) {
    addSeen(player.battlefield);
    addSeen(player.graveyard);
    addSeen(player.exile);
  }
  // the reveals still listed, each card with the zone it was revealed from
  const revealed: { key: string; entry: string; card: CardView }[] = [];
  for (const group of view.revealed ?? []) {
    for (const [id, card] of Object.entries(group.cards ?? {})) {
      const key = physicalId(card, id);
      revealed.push({ key, entry: `${group.name ?? ''}\0${key}`, card: { ...card, id: card.id ?? id } });
    }
  }
  const listed = new Set(revealed.map(({ entry }) => entry));

  const next = new Map<string, RevealedHand>();
  for (const player of view.players ?? []) {
    const playerId = player.playerId;
    if (!playerId) continue;
    const before = previous.get(playerId);
    const ownHand = view.myPlayerId === playerId ? view.myHand : undefined;
    const held = ownHand && new Set(Object.entries(ownHand).map(([id, card]) => physicalId(card, id)));
    const handCount = held?.size ?? player.handCount ?? 0;
    const inPublic = new Set([...seen].filter(([, owner]) => owner === playerId).map(([key]) => key));
    const forgotten = new Set([...before?.forgotten ?? []].filter((key) => listed.has(key)));
    const cards = new Map(before?.cards ?? []);
    const forgetAll = () => {
      for (const { entry, card } of revealed) if (card.ownerId === playerId && card.zone === 'HAND') forgotten.add(entry);
      cards.clear();
    };

    // the hand lost more cards than showed up in public: some left for a hidden zone, which ones is unknown
    if (before && !held) {
      const lost = before.handCount - handCount;
      // theirs by owner, or by being a card remembered in their hand
      const surfaced = new Set([...inPublic, ...[...cards.keys()].filter((key) => seen.has(key))].filter((key) => !before.inPublic.has(key))).size;
      if (lost > 0 && lost > surfaced) forgetAll();
    }
    for (const key of cards.keys()) {
      if (seen.has(key) || (held && !held.has(key))) {
        cards.delete(key);
      }
    }
    for (const { key, entry, card } of revealed) {
      if (card.ownerId !== playerId || card.zone !== 'HAND') continue;
      if (seen.has(key) || (held && !held.has(key))) forgotten.add(entry);
      if (forgotten.has(entry)) continue;
      if (!cards.has(key)) cards.set(key, card);
    }
    // more remembered than held: which ones left is unknown
    if (cards.size > handCount) forgetAll();
    next.set(playerId, { cards, handCount, inPublic, forgotten });
  }
  return next;
}

/** A player's revealed cards still in hand. */
export function revealedInHand(hands: RevealedHands, playerId: string | undefined): CardView[] {
  const hand = playerId ? hands.get(playerId) : undefined;
  return hand ? [...hand.cards.values()] : [];
}
