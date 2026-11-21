import { createContext } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { BrowserInputLock } from '../../core/game/gameSession';
import { useSession } from '../stores/session';
import { PRIVATE_PLAYTESTING } from '../playtesting';

export const MatchHumanSeat = createContext<string | null>(null);

export function humanSeatQuery(account: string, tableId?: string | null) {
  return queryOptions<string | null>({
    queryKey: ['human-mcp-seat', account, tableId],
    enabled: PRIVATE_PLAYTESTING && !!account && !!tableId,
    staleTime: Infinity,
    retry: false,
    refetchInterval: (query) => query.state.status === 'error' ? 5000 : false,
    queryFn: async ({ signal }): Promise<string | null> => {
      const response = await fetch('/api/playtesting/human-seat/' + encodeURIComponent(tableId!), { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Could not read match permissions');
      const seat = await response.json();
      if (seat.tableId !== tableId || typeof seat.humanMcpAllowed !== 'boolean'
        || (seat.humanMcpAllowed && typeof seat.humanName !== 'string')) throw new Error('Invalid match permissions');
      return seat.humanMcpAllowed ? seat.humanName.trim().toLowerCase() : null;
    },
  });
}

export function inputLockFor(account: string, result: { status: string; data?: string | null }): BrowserInputLock {
  if (!PRIVATE_PLAYTESTING) return null;
  if (result.status === 'error') return 'unavailable';
  if (!account || result.status !== 'success') return 'pending';
  return result.data === account.trim().toLowerCase() ? 'delegated' : null;
}

function useHumanSeatQuery(tableId?: string | null) {
  const account = useSession((state) => state.phase === 'signedIn' ? state.userName : '');
  const result = useQuery(humanSeatQuery(account, tableId));
  return { account, result };
}

export function useHumanInputLock(tableId?: string | null) {
  const { account, result } = useHumanSeatQuery(tableId);
  return inputLockFor(account, result);
}

export function useEnabledHumanSeat(tableId?: string | null) {
  return useHumanSeatQuery(tableId).result.data ?? null;
}
