export function archetypesFor(format?: string | null): string[];
export function classifyArchetype(format?: string | null, name?: string | null, cards?: readonly (string | { cardName?: string; name?: string })[]): string;
export function tournamentArchetype(format: string, cards: readonly (string | { cardName?: string; name?: string })[]): string | null;
