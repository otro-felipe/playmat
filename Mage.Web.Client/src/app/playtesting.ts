export const PRIVATE_PLAYTESTING = import.meta.env.VITE_PRIVATE_PLAYTESTING === 'true';

export interface PlaytestingInvite {
  tableId: string;
  roomId: string;
  format: string;
  password: string;
}

export type PlaytestingOpponent = { mode: 'friend'; guestEngineName: string } | { mode: 'mcp' };

export interface PlaytestingInvitationView {
  mode: 'friend' | 'mcp';
  guestEngineName: string | null;
  guestDisplayName: string | null;
}

async function sendInviteRequest(path: string, input?: Record<string, unknown>): Promise<Response> {
  const response = await fetch(`/api/playtesting/invites${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  if (response.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  if (!response.ok) throw new Error('This invitation could not be used. Check the player name or ask for a new link.');
  return response;
}

export async function createPlaytestingInvite(invite: PlaytestingInvite, opponent: PlaytestingOpponent): Promise<void> {
  await sendInviteRequest('', { ...invite, ...opponent });
}

export async function getPlaytestingInvitation(tableId: string, signal: AbortSignal): Promise<PlaytestingInvitationView | null> {
  const response = await fetch(`/api/playtesting/invites/${encodeURIComponent(tableId)}`, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('This invitation could not be read.');
  return response.json();
}

export async function claimPlaytestingInvite(tableId: string): Promise<PlaytestingInvite> {
  const response = await sendInviteRequest(`/${encodeURIComponent(tableId)}/claim`);
  const invite = await response.json() as PlaytestingInvite;
  if (invite.tableId !== tableId || typeof invite.password !== 'string') throw new Error('Invalid invitation.');
  return invite;
}
