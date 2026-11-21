// Fictitious state projected by the broadcast endpoint, independent of either seat.
export const spectatorToken = 'sample-broadcast-for-browser-fixture';
export const spectatorSnapshot = {
  role: 'spectator', tableId: '00000000-0000-4000-8000-0000000000ab', gameId: '00000000-0000-4000-8000-0000000000ac',
  status: 'playing', spectators: 2,
  players: [{ playerId: 'seat-a', name: 'Alice' }, { playerId: 'seat-b', name: 'Bob' }],
  view: { turn: 3, step: 'PRECOMBAT_MAIN', activePlayerId: 'seat-a', activePlayerName: 'Alice', players: [
    { playerId: 'seat-a', name: 'Alice', life: 18, handCount: 1, libraryCount: 47 },
    { playerId: 'seat-b', name: 'Bob', life: 15, handCount: 1, libraryCount: 44 },
  ] },
  hands: {
    'seat-a': { forest: { id: 'forest', name: 'Forest', expansionSetCode: 'M21', cardNumber: '273' } },
    'seat-b': { bolt: { id: 'bolt', name: 'Lightning Bolt', expansionSetCode: 'M11', cardNumber: '146' } },
  }, chat: [], lines: [],
};
