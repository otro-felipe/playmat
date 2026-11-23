import { createContext, useContext, useMemo } from 'react';
import { QueryClient, useQueries, useQuery, queryOptions, type UseQueryResult } from '@tanstack/react-query';
import { PRIVATE_PLAYTESTING } from '../playtesting';
import { playerLabelText, type PlayerIdentity } from './playerIdentity';

const identities = new QueryClient();
const engineName = /^(?:[a-z0-9_-]{3,24}|mcp_[a-z0-9_-]{3,24})$/i;
type Waiter = { resolve(value: PlayerIdentity | null): void; reject(reason: unknown): void };
const pending = new Map<string, Waiter[]>();

async function requestBatch(batch: [string, Waiter[]][]) {
  try {
    const params = new URLSearchParams({ names: batch.map(([name]) => name).join(',') });
    const response = await fetch('/api/playtesting/player-identities?' + params);
    if (!response.ok) throw new Error('Player identity unavailable');
    const { players } = await response.json() as { players: PlayerIdentity[] };
    const found = new Map(players.map((player) => [player.name.toLowerCase(), player]));
    for (const [name, waiters] of batch) {
      for (const waiter of waiters) waiter.resolve(found.get(name) ?? null);
    }
  } catch (error) {
    for (const [, waiters] of batch) for (const waiter of waiters) waiter.reject(error);
  }
}

function lookup(name: string): Promise<PlayerIdentity | null> {
  return new Promise((resolve, reject) => {
    if (!pending.size) queueMicrotask(() => {
      const batch = [...pending];
      pending.clear();
      for (let i = 0; i < batch.length; i += 50) void requestBatch(batch.slice(i, i + 50));
    });
    const waiters = pending.get(name) ?? [];
    waiters.push({ resolve, reject });
    pending.set(name, waiters);
  });
}

function identityKey(name: string) {
  return ['playerIdentity', name.toLowerCase()] as const;
}

/** Refetch through the ordinary permission-checked directory after an owner edits a seat. */
export async function refreshPlayerIdentity(name: string) {
  const filter = { queryKey: identityKey(name), exact: true };
  await identities.cancelQueries(filter);
  await identities.invalidateQueries(filter);
}

function options(name: string, enabled = true) {
  const key = name.toLowerCase();
  return queryOptions({
    queryKey: identityKey(key),
    queryFn: () => lookup(key),
    enabled: PRIVATE_PLAYTESTING && enabled && engineName.test(key),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export const PublicBroadcast = createContext(false);

export function usePlayerIdentity(name: string, enabled = true) {
  const broadcast = useContext(PublicBroadcast);
  const result = useQuery(options(name, enabled && !broadcast), identities);
  return broadcast ? undefined : result.data;
}

function directory(results: UseQueryResult<PlayerIdentity | null>[]): Record<string, PlayerIdentity> {
  return Object.fromEntries(results.flatMap(({ data }) => data ? [[data.name.toLowerCase(), data]] : []));
}

export type FormatPlayerName = (name: string, alias?: string | null) => string;
export const PlayerNames = createContext<FormatPlayerName>(playerLabelText);
export const usePlayerNames = () => useContext(PlayerNames);

/** Resolve the whole table once for labels embedded in sentences, native options and replay annotations. */
export function useRosterNames(names: readonly (string | undefined)[]) {
  const broadcast = useContext(PublicBroadcast);
  const keys = broadcast ? [] : [...new Set(names.filter((name): name is string => !!name && engineName.test(name)).map((name) => name.toLowerCase()))];
  const roster = useQueries({ queries: keys.map((name) => options(name)), combine: directory }, identities);
  return useMemo<FormatPlayerName>(() => (name, alias) => {
    const seat = roster[name.toLowerCase()];
    return playerLabelText(name, seat?.displayName ?? alias, seat?.isMcp);
  }, [roster]);
}
