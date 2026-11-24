import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentModel } from '../ui/agentModel';

export const tournamentApi = '/api/playtesting/tournaments';
export const tournamentPath = (id: string) => '/tournaments/' + encodeURIComponent(id);
export interface Viewer {
  isAdmin: boolean;
  accountName?: string;
  username?: string;
  entryIds?: string[];
}
export interface Entry extends AgentModel {
  id: string;
  playerId?: string;
  name: string;
  owner: string;
  kind: 'human' | 'agent';
  online: boolean;
  state: string;
  rank: number;
  points: number;
  wins: number;
  losses: number;
  ties: number;
  omw: number;
  gw: number;
  ogw: number;
}
export interface Pairing {
  id: string;
  roundNumber: number;
  stage: 'swiss' | 'playoffs';
  number: number;
  a: string;
  b: string | null;
  tableId?: string;
  matchId?: string;
  completed: boolean;
  winsA: number;
  winsB: number;
  draws: number;
  playUrl?: string;
  watchUrl?: string;
  replayUrl?: string;
  deadlineAt?: number;
  attendanceDeadlineAt?: number;
  absentWarningIds?: string[];
  winner?: string | null;
}
type Card = { amount: number; cardName: string };
export interface RegisteredDeck {
  entryId: string;
  name: string;
  /** the list's public archetype (Pioneer: MTGTop8 name), when classified */
  archetype?: string | null;
  cards: Card[];
  sideboard: Card[];
}
export type TournamentStatus = 'registration' | 'playing' | 'break' | 'paused' | 'finished' | 'cancelled';
export interface Summary {
  id: string;
  name: string;
  format: string;
  template: 'attendance' | 'worlds';
  capacity: number;
  registeredCount: number;
  status: TournamentStatus;
  roundNumber: number;
}
export interface Tournament extends Summary {
  cut: 'auto' | 'none';
  swissBestOf: number;
  playoffBestOf: number;
  stage: 'registration' | 'swiss' | 'playoffs';
  coaching: boolean;
  roundsTotal: number;
  cutSize: number;
  maxAgentsPerOwner: number;
  breakMinutes: number;
  deadlineAt: number | null;
  nextRoundAt: number | null;
  nextSessionAt: number | null;
  championId: string | null;
  viewer: Viewer | null;
  participants: Entry[];
  standings: Entry[];
  pairings: Pairing[];
  deckLists: RegisteredDeck[];
}
export interface StructureRange {
  upTo: number;
  swissRounds: number;
  cutSize: number;
  roundsOnly: number;
}
export interface TournamentList {
  attendanceStructures?: StructureRange[];
  tournaments: Summary[];
  mayCreate: boolean;
  viewer: Viewer | null;
}
export type AdminAction = 'start' | 'pause' | 'resume' | 'extend' | 'structure';
export interface Participation extends AgentModel {
  tournamentId: string;
  name: string;
  kind: 'human' | 'agent';
  entryName: string;
  champion: boolean;
}
export interface Profile {
  owner: string;
  agents: (AgentModel & { id: string; name: string })[];
  participations: Participation[];
  trophies: Participation[];
}

export async function request<T>(
  url: string,
  body?: object,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    headers: { ...headers, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
    signal,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new Error(typeof details?.error === 'string' ? details.error : 'HTTP ' + response.status);
  }
  return response.json();
}

export function useTournamentOwner(alias: string) {
  return useQuery({
    queryKey: ['tournament-owner', alias.toLowerCase()],
    queryFn: ({ signal }) => request<Profile>(tournamentApi + '/profile/' + encodeURIComponent(alias), undefined, signal),
    retry: false,
  });
}

export function useTournament(id: string) {
  const client = useQueryClient();
  const url = tournamentApi + '/' + encodeURIComponent(id);
  const query = useQuery({
    queryKey: ['tournament', id],
    queryFn: ({ signal }) => request<Tournament>(url, undefined, signal),
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  });
  useEffect(() => {
    if (!id || typeof EventSource === 'undefined') return;
    const source = new EventSource(url + '/events');
    source.addEventListener('snapshot', (event: MessageEvent<string>) => {
      try {
        const fresh: Tournament = JSON.parse(event.data);
        if (fresh?.id === id && Array.isArray(fresh.participants)) client.setQueryData(['tournament', id], fresh);
      } catch {
        void client.invalidateQueries({ queryKey: ['tournament', id] });
      }
    });
    return () => source.close();
  }, [id, client, url]);
  return query;
}
