import type { AgentModel } from '../ui/agentModel';

export interface PlayerSettings extends AgentModel {
  displayName: string;
  flag: string | null;
  mcpEnabled: boolean;
}

export interface McpPlayer extends PlayerSettings {
  playerId: string;
  engineName: string;
  availability: 'available' | 'occupied' | 'reserved' | 'disabled';
}

const endpoint = '/api/playtesting/players';

export class PlayerRequestError extends Error {
  constructor(public status: number) { super('Player request failed'); }
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(endpoint + path, init);
  if (!response.ok) throw new PlayerRequestError(response.status);
  return response;
}

export async function getMcpPlayers(signal: AbortSignal): Promise<McpPlayer[]> {
  const response = await request('', { signal, cache: 'no-store' });
  return (await response.json()).players;
}

export async function saveMcpPlayer(id: string | null, fields: Partial<PlayerSettings>): Promise<McpPlayer> {
  const response = await request(id ? '/' + encodeURIComponent(id) : '', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  return response.json();
}

export async function removeMcpPlayer(id: string): Promise<void> {
  await request('/' + encodeURIComponent(id), { method: 'DELETE' });
}
