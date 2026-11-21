export interface SpectatorLine {
  lineId: string;
  playerId: string;
  playerName: string;
  reasoning: string;
  at: number;
  turn?: number;
}
export interface SpectatorChatMessage {
  messageId: string;
  playerName: string;
  message: string;
  at: number;
}
export type SpectatorFeedEvent = { gameId: string; key: string; at: number; playerName: string; text: string } & (
  { kind: 'line'; playerId: string } | { kind: 'chat' }
);

/** Reconnect snapshots can repeat events. Command IDs are unique within an acting seat. */
export function spectatorFeed(gameId: string, lines: readonly SpectatorLine[] = [], chat: readonly SpectatorChatMessage[] = []) {
  const rows = new Map<string, SpectatorFeedEvent>();
  for (const line of lines) {
    if (!line.lineId || !line.playerId || !line.reasoning?.trim() || !Number.isFinite(line.at)) continue;
    const key = JSON.stringify([gameId, 'line', line.playerId, line.lineId]);
    rows.set(key, { key, gameId, kind: 'line', playerId: line.playerId, playerName: line.playerName, text: line.reasoning, at: line.at });
  }
  for (const item of chat) {
    if (!item.messageId || !item.message?.trim() || !Number.isFinite(item.at)) continue;
    const key = JSON.stringify([gameId, 'chat', item.messageId]);
    rows.set(key, { key, gameId, kind: 'chat', playerName: item.playerName, text: item.message, at: item.at });
  }
  return [...rows.values()].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
