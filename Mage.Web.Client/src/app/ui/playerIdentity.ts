import type { AgentModel } from './agentModel';

export interface PlayerIdentity extends AgentModel {
  name: string;
  displayName: string;
  isMcp: boolean;
}

/** Engine names remain the keys for moves, invitations and chat. */
export function playerIdentity(name: string, displayName?: string | null, isMcp = /^mcp_/i.test(name)): PlayerIdentity {
  if (!isMcp) return { name, displayName: displayName || name, isMcp };
  const suffix = name.replace(/^mcp_/i, '');
  // A ten-hex suffix used to be random. Only a verified owner can supply that seat's name.
  const fallback = /^[a-f0-9]{10}$/i.test(suffix) ? '' : suffix;
  return { name, displayName: displayName || fallback, isMcp };
}

export function playerLabelText(name: string, displayName?: string | null, isMcp?: boolean): string {
  const seat = playerIdentity(name, displayName, isMcp);
  return seat.isMcp ? (seat.displayName ? seat.displayName + ' (MCP)' : 'MCP') : seat.displayName;
}

/** Player names embedded in system prompts and game results. Leave player-authored chat verbatim. */
export function formatEngineText(text: string, format: (name: string) => string = playerLabelText): string {
  return text.replace(/\bmcp_[a-z0-9_-]+/gi, (name) => format(name));
}
