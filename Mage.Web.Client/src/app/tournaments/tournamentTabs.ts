import type { Tournament } from './tournamentApi';

export type Tab = 'bracket' | 'stats' | 'decklists';
export const tabs: Tab[] = ['bracket', 'stats', 'decklists'];

/** A finished tournament opens on its statistics and result; one in progress on its bracket. */
export function tournamentTab(requested: string | null, status: Tournament['status']): Tab {
  return tabs.includes(requested as Tab) ? (requested as Tab) : status === 'finished' ? 'stats' : 'bracket';
}
