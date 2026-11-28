import type { Entry, Pairing, Tournament, Viewer } from './tournamentApi';

/** The archetype a participant played: the snapshot's own field, or its published decklist. */
export function entryArchetype(cup: Tournament, entry: Entry): { name: string | null; colors: Entry['colors'] } {
  const name = entry.archetype ?? cup.deckLists?.find((deck) => deck.entryId === entry.id)?.archetype ?? null;
  return { name, colors: entry.colors ?? null };
}

/** Owners are named on each row only when the tournament mixes several of them. */
export function sharedOwner(cup: Tournament): string | null {
  const owners = new Set((cup.participants ?? []).map((entry) => entry.owner));
  return owners.size === 1 ? [...owners][0] : null;
}

/** Gate archive lookups by the current cookie-authenticated tournament viewer. */
export function pairingQualityOwner(viewer: Viewer | null | undefined, pair: Pairing | undefined) {
  if (pair?.completed && pair.b && pair.a !== pair.b && viewer?.accountName
    && viewer.entryIds?.includes(pair.a) && viewer.entryIds.includes(pair.b)) {
    return viewer.accountName;
  }
}
