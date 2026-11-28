type DeckCard = string | { cardName?: string; name?: string; amount?: number; quantity?: number; count?: number };

export function archetypesFor(format?: string | null): string[];
export function classifyArchetype(format?: string | null, name?: string | null, cards?: readonly DeckCard[]): string;
export function tournamentArchetype(format: string | null | undefined, cards: readonly DeckCard[]): string | null;
export function isCreaturePracticeMain(cards: readonly DeckCard[]): boolean;
export function canonicalArchetype(format: string | null | undefined, label: string): string;
export function archetypeSourceUrl(format: string | null | undefined, label: string): string | null;
export function archetypeColors(archetype?: string | null): ('W' | 'U' | 'B' | 'R' | 'G')[] | null;
