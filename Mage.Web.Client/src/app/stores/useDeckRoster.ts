import { useMemo } from 'react';
import { rosterOf, useDecks } from './decks';
import { useSettings } from './settings';
import { PRIVATE_PLAYTESTING } from '../playtesting';
import { useLibraryReady } from './deckSyncStatus';

/** Visible decks for the library and pickers; saved starter copies remain yours. */
export function useDeckRoster(library: 'personal' | 'agent' | 'private' = 'personal', playerId?: string) {
  const saved = useDecks((state) => state.saved);
  const starters = useDecks((state) => state.starters);
  const hideStarterDecks = useSettings((state) => state.settings.hideStarterDecks);
  const ready = useLibraryReady();
  return useMemo(() => !ready ? [] : rosterOf({ saved, starters }, hideStarterDecks)
    .filter((deck) => !PRIVATE_PLAYTESTING || ((deck.library ?? 'personal') === library && (library !== 'private' || deck.playerId === playerId))), [ready, saved, starters, hideStarterDecks, library, playerId]);
}
