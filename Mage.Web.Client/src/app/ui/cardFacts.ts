import { useQuery } from '@tanstack/react-query';
import { configuredImageProxy, proxiedScryfallUrl } from '../../core/images/imageProxy';

/** What a decklist needs to group and sort a card at a glance. */
export interface CardFacts {
  manaCost: string;
  manaValue: number;
  /** the front face's type line */
  typeLine: string;
}

interface ScryfallCard {
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  card_faces?: { name: string; mana_cost?: string; type_line?: string }[];
}

const COLLECTION = 'https://api.scryfall.com/cards/collection';
const known = new Map<string, CardFacts | null>();
const key = (name: string) => name.normalize('NFKC').trim().toLowerCase();
const front = (name: string) => name.split(/\s+\/\/\s+/)[0];

function facts(card: ScryfallCard): CardFacts {
  const face = card.card_faces?.[0];
  return {
    // An adventure or split card prints both costs ("{W} // {1}{W}"); a decklist shows the front one.
    manaCost: face?.mana_cost || card.mana_cost?.split(' // ')[0] || '',
    manaValue: card.cmc ?? 0,
    typeLine: face?.type_line ?? card.type_line?.split(' // ')[0] ?? '',
  };
}

async function lookup(names: string[], signal?: AbortSignal) {
  const url = proxiedScryfallUrl(COLLECTION, configuredImageProxy());
  for (let start = 0; start < names.length; start += 75) {
    const batch = names.slice(start, start + 75);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
      signal,
    });
    if (!response.ok) throw new Error('Scryfall ' + response.status);
    const body = (await response.json()) as { data?: ScryfallCard[] };
    for (const card of body.data ?? []) {
      const value = facts(card);
      known.set(key(card.name), value);
      known.set(key(front(card.name)), value);
    }
  }
}

/**
 * Mana cost, mana value and type of each named card, read from Scryfall in batches of 75 and kept for the session.
 * Double-faced and split cards are found by their full name or their front face.
 */
export function useCardFacts(names: readonly string[]): ReadonlyMap<string, CardFacts> {
  const wanted = [...new Set(names.map(key))].sort();
  const query = useQuery({
    queryKey: ['card-facts', wanted],
    enabled: wanted.length > 0,
    staleTime: Infinity,
    retry: 1,
    queryFn: async ({ signal }) => {
      const missing = names.filter((name) => !known.has(key(name)));
      if (missing.length) {
        await lookup([...new Set(missing)], signal);
        const fronts = missing.filter((name) => !known.has(key(name)) && front(name) !== name).map(front);
        if (fronts.length) await lookup([...new Set(fronts)], signal);
        for (const name of missing) if (!known.has(key(name))) known.set(key(name), null);
      }
      const result = new Map<string, CardFacts>();
      for (const name of names) {
        const value = known.get(key(name)) ?? known.get(key(front(name)));
        if (value) result.set(name, value);
      }
      return result;
    },
  });
  return query.data ?? empty;
}
const empty: ReadonlyMap<string, CardFacts> = new Map();

export type CardGroup = 'creature' | 'planeswalker' | 'battle' | 'instant' | 'sorcery' | 'enchantment' | 'artifact' | 'land' | 'other';
export const cardGroups: CardGroup[] = ['creature', 'planeswalker', 'battle', 'instant', 'sorcery', 'enchantment', 'artifact', 'land', 'other'];

const detection: CardGroup[] = ['creature', 'land', 'planeswalker', 'battle', 'instant', 'sorcery', 'enchantment', 'artifact'];

/** The group a card is listed under, the way decklist sites list them: a creature land is a creature. */
export function cardGroup(facts: CardFacts | undefined): CardGroup {
  const type = facts?.typeLine.split('—')[0] ?? '';
  if (!type) return 'other';
  // Creatures first (a creature land or artifact creature is a creature), then lands (an artifact land is a land).
  for (const group of detection) if (new RegExp('\\b' + group + '\\b', 'i').test(type)) return group;
  return 'other';
}

/** mana-font classes for a Scryfall mana cost such as {2}{W/U}{G/P}. */
export function manaSymbols(cost: string): string[] {
  return [...cost.matchAll(/\{([^}]+)\}/g)].map(([, symbol]) => 'ms-' + symbol.toLowerCase().replace('/', ''));
}
