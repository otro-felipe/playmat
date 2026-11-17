// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { createFakeConnection, type FakeConnection } from '../../test/fakeConnection';

const SERVER = 'wss://playmat.test/ws';
const ACCOUNT = `${SERVER}|alice`;
const ROOT = '/api/playtesting/decks';

function deck(id: string, name: string, updatedAt: number) {
  return { id, name, updatedAt, format: 'Pioneer', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('[PM-AC-20] a failed deck operation preserves local work and allows other decks to sync', async () => {
  vi.resetModules();
  vi.doMock('../connection', () => createFakeConnection());
  vi.doMock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
  const { api } = await import('../connection') as unknown as FakeConnection;
  api.serverInfo.mockResolvedValue({ deckSync: true });
  const { useSession } = await import('./session');
  const { deckStorage } = await import('../../core/decks/DeckStorageService');
  const { useDeckSyncStatus } = await import('./deckSyncStatus');

  const localConflict = deck('edit-conflict', 'My local edit', 20);
  const localNew = deck('local-new', 'New local deck', 30);
  const fromMcp = deck('from-mcp', 'Deck created by MCP', 40);
  const remoteList = [
    { id: localConflict.id, revision: 2, updatedAt: 10 },
    { id: 'delete-conflict', revision: 2, updatedAt: 10 },
    { id: fromMcp.id, revision: 1, updatedAt: fromMcp.updatedAt },
  ];
  deckStorage.setAccountScope(ACCOUNT);
  deckStorage.importFromSync(localConflict.id, JSON.stringify(localConflict));
  deckStorage.importFromSync(localNew.id, JSON.stringify(localNew));
  await deckStorage.deleteDeck('delete-conflict');
  localStorage.setItem('playtesting.deckRevisions', JSON.stringify({ [ACCOUNT]: {
    [localConflict.id]: 1, 'delete-conflict': 1,
  } }));

  const sent: { id: string; method?: string; revision: number; name?: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === `${ROOT}?deleted=1`) return Response.json({ decks: remoteList });
    if (url === `${ROOT}/${fromMcp.id}` && !init?.method) return Response.json({ ...remoteList[2], data: fromMcp });
    if (!url.startsWith(`${ROOT}/`)) return Response.json([]);
    const id = url.slice(ROOT.length + 1);
    const payload = JSON.parse(String(init?.body));
    sent.push({ id, method: init?.method, revision: payload.expectedRevision, name: payload.data?.name });
    if (id === localNew.id) return Response.json({ id, revision: 1, updatedAt: localNew.updatedAt });
    return Response.json({ error: 'Deck revision has changed' }, { status: 409 });
  });

  await import('./deckSync');
  useSession.setState({ phase: 'signedIn', loginCount: 1, userName: 'Alice', serverUrl: SERVER });
  await vi.waitFor(() => expect(useDeckSyncStatus.getState().status).toBe('error'));

  expect(await deckStorage.loadDeck(localConflict.id)).toEqual(localConflict);
  expect(await deckStorage.loadDeck(fromMcp.id)).toEqual(fromMcp);
  expect(deckStorage.tombstones()).toHaveProperty('delete-conflict');
  expect(sent).toEqual([
    { id: localConflict.id, method: 'PUT', revision: 1, name: localConflict.name },
    { id: localNew.id, method: 'PUT', revision: 0, name: localNew.name },
    { id: 'delete-conflict', method: 'DELETE', revision: 1, name: undefined },
  ]);
  expect(JSON.parse(localStorage.getItem('playtesting.deckRevisions')!)[ACCOUNT]).toEqual({
    [localConflict.id]: 1, 'delete-conflict': 1, [localNew.id]: 1, [fromMcp.id]: 1,
  });
  expect(useDeckSyncStatus.getState().error).toContain('Conservamos tus cambios');
});
