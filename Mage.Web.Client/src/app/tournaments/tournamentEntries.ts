import type { Entry, Tournament } from './tournamentApi';

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
