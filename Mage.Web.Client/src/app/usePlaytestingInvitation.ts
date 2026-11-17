import { useQuery } from '@tanstack/react-query';
import { getPlaytestingInvitation, PRIVATE_PLAYTESTING } from './playtesting';

export function usePlaytestingInvitation(tableId: string | null | undefined, tableState?: string | null) {
  return useQuery({
    queryKey: ['playtesting-invitation', tableId, tableState],
    queryFn: ({ signal }) => getPlaytestingInvitation(tableId!, signal),
    enabled: PRIVATE_PLAYTESTING && Boolean(tableId),
    refetchInterval: ({ state }) => tableState === 'WAITING' && state.data?.mode === 'mcp' ? 1500 : false,
    retry: false,
  });
}
