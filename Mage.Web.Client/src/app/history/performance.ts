import { useQuery } from '@tanstack/react-query';
import { formatNumber } from '../i18n';

export interface Outcome {
  total: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface DeckFamily {
  id: string;
  name: string;
  format: string;
  archetype: string | null;
  currentVersion: number;
  versions: { version: number; format: string; archetype: string | null }[];
}

export interface PerformanceGroup {
  deckIds: string[];
  format: string;
  archetype: string | null;
  matches: Outcome;
  games: Outcome;
}

export interface Performance {
  decks: DeckFamily[];
  groups: PerformanceGroup[];
  selected: { deckId: string | null; version: number | null };
  options: { ownArchetypes: string[]; opponentArchetypes: string[] };
  summary: { matches: Outcome; games: Outcome };
  observedBestOf?: (number | null)[];
  matchups: {
    archetype: string | null;
    matches: Outcome;
    games: Outcome;
    mulligans: { known: number; taken: number; opponentKnown: number; opponentTaken: number };
  }[];
  splits: { preboard: Outcome; postboard: Outcome; play: Outcome; draw: Outcome };
  mulligans: { count: number; games: Outcome }[];
  openingCards: { card: string; games: Outcome; without: Outcome }[];
  opponentCards: { card: string; games: Outcome; gameIds: string[] }[];
  coverage: { keptHands: number; opponentCards: number; games: number };
}

export function rate(numerator: number, total: number) {
  return total ? formatNumber(numerator / total, { style: 'percent', maximumFractionDigits: 0 }) : '—';
}

export function sample(numerator: number, total: number) {
  return formatNumber(numerator) + '/' + formatNumber(total);
}

export function analysisSearch(group: PerformanceGroup) {
  const query = new URLSearchParams({ scope: 'archetype', format: group.format });
  if (group.archetype) query.set('ownArchetype', group.archetype);
  else query.set('ownArchetypeUnknown', 'true');
  return query;
}

export function usePerformance(account: string, search: URLSearchParams) {
  const query = new URLSearchParams(search);
  query.delete('tab');
  query.sort();
  const request = query.toString();
  return useQuery({
    queryKey: ['playtesting-performance', account, request],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/playtesting/performance?' + request, { signal });
      if (!response.ok) throw new Error('Performance request failed');
      return await response.json() as Performance;
    },
    placeholderData: (previous) => previous,
    enabled: !!account,
    refetchInterval: 15_000,
  });
}
