import { create } from 'zustand';
import { PRIVATE_PLAYTESTING } from '../playtesting';

export type DeckSyncStatus = 'off' | 'syncing' | 'synced' | 'error';

/** Whether decks are kept on the server for this account, and how the last sync went (see stores/deckSync). */
export const useDeckSyncStatus = create<{ status: DeckSyncStatus; ready: boolean; lastSyncedAt: number | null; error: string | null }>(() => ({
  ready: !PRIVATE_PLAYTESTING,
  status: 'off',
  lastSyncedAt: null,
  error: null,
}));

export function useLibraryReady() {
  const ready = useDeckSyncStatus((state) => state.ready);
  return !PRIVATE_PLAYTESTING || ready;
}
