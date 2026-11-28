export type Tab = 'bracket' | 'mine' | 'stats' | 'decklists';
export const allTabs: Tab[] = ['bracket', 'mine', 'stats', 'decklists'];

/** The tabs a viewer sees: "Mine" only for someone with participants in the tournament. */
export function visibleTabs(mine: boolean): Tab[] {
  return mine ? allTabs : allTabs.filter((tab) => tab !== 'mine');
}

/** A tournament always opens on its standings and tables. */
export function tournamentTab(requested: string | null, mine = false): Tab {
  return visibleTabs(mine).includes(requested as Tab) ? (requested as Tab) : 'bracket';
}
