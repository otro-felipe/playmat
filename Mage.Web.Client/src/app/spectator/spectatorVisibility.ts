export type Visibility = 'public-board' | 'both-hands';

export interface OwnedBroadcast {
  tableId: string;
  tableName: string;
  spectatorVisibility?: Visibility;
  canConfigureSpectatorVisibility?: boolean;
}

export const ownedBroadcastsKey = (owner: string | null) => ['owned-mcp-broadcasts', owner] as const;

export class VisibilityLocked extends Error {}

export async function saveVisibility(tableId: string, value: Visibility) {
  const response = await fetch('/api/playtesting/tables/' + encodeURIComponent(tableId) + '/spectator-link', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spectatorVisibility: value }),
  });
  if (response.status === 409) throw new VisibilityLocked();
  if (!response.ok) throw new Error('Could not save spectator access');
  const saved = await response.json();
  if (saved.tableId !== tableId || saved.spectatorVisibility !== value) throw new Error('Unexpected spectator access response');
  return value;
}
