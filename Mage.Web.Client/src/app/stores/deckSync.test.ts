// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { createFakeConnection, type FakeConnection } from '../../test/fakeConnection';

const SERVER = 'wss://playmat.test/ws';
const ACCOUNT = `${SERVER}|alice`;
const ROOT = '/api/playtesting/decks';

test('switching private accounts during a download cannot publish the previous library into the new account', async () => {
  vi.resetModules();
  vi.doMock('../connection', () => createFakeConnection());
  vi.doMock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
  const { useSession } = await import('./session');
  const { deckStorage } = await import('../../core/decks/DeckStorageService');
  const { useDecks } = await import('./decks');
  const { useDeckSyncStatus } = await import('./deckSyncStatus');
  let releaseOld!: (response: Response) => void;
  let oldRequested!: () => void;
  const started = new Promise<void>((resolve) => { oldRequested = resolve; });
  const aliceDeck = deck('alice-only', 'Private Alice deck', 10);
  const bobDeck = deck('bob-only', 'Private Bob deck', 20);
  const writes: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const owner = (init?.headers as Record<string, string>)?.['X-Playmat-Deck-Owner'];
    if (url === `${ROOT}?deleted=1`) {
      const data = owner === 'Alice' ? aliceDeck : bobDeck;
      return Response.json({ decks: [{ id: data.id, updatedAt: data.updatedAt, revision: 1 }] });
    }
    if (url === `${ROOT}/${aliceDeck.id}`) {
      oldRequested();
      return new Promise<Response>((resolve) => { releaseOld = resolve; });
    }
    if (url === `${ROOT}/${bobDeck.id}`) return Response.json({ revision: 1, data: bobDeck });
    if (init?.method === 'PUT') writes.push(`${owner}:${url}`);
    return Response.json({ decks: [] });
  });
  await import('./deckSync');
  useSession.setState({ phase: 'signedIn', loginCount: 1, userName: 'Alice', serverUrl: SERVER });
  await started;
  expect(useDeckSyncStatus.getState().ready).toBe(false);
  useSession.setState({ phase: 'signedOut' });
  expect(useDecks.getState().saved).toEqual([]);
  useSession.setState({ phase: 'signedIn', loginCount: 2, userName: 'Bob' });
  await vi.waitFor(() => expect(useDeckSyncStatus.getState()).toMatchObject({ ready: true, status: 'synced' }));
  releaseOld(Response.json({ revision: 1, data: aliceDeck }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await deckStorage.listDecks()).map((entry) => entry.id)).toEqual(['bob-only']);
  expect(useDecks.getState().saved.map((entry) => entry.id)).toEqual(['bob-only']);
  expect(writes).toEqual([]);
});

function deck(id: string, name: string, updatedAt: number) {
  return { id, name, updatedAt, format: 'Pioneer', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] };
}

test('[PM-AC-20] returning to the same account fences an old connection download before its next write', async () => {
  vi.resetModules();
  vi.doMock('../connection', () => createFakeConnection());
  vi.doMock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
  const { useSession } = await import('./session');
  const { deckStorage } = await import('../../core/decks/DeckStorageService');
  const { useDeckSyncStatus } = await import('./deckSyncStatus');
  const oldDeck = deck('alice-shared', 'Old Alice deck', 10);
  const currentDeck = deck('alice-shared', 'Current Alice deck', 20);
  let releaseOld!: (response: Response) => void;
  let oldRequested!: () => void;
  const started = new Promise<void>((resolve) => { oldRequested = resolve; });
  let lists = 0, downloads = 0;
  const writes: number[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const owner = (init?.headers as Record<string, string>)?.['X-Playmat-Deck-Owner'];
    if (init?.method === 'PUT') {
      const revision = JSON.parse(String(init.body)).expectedRevision as number;
      writes.push(revision);
      return revision === 2 ? Response.json({ revision: 3 }) : Response.json({}, { status: 409 });
    }
    if (url === `${ROOT}?deleted=1`) {
      if (owner !== 'Alice') return Response.json({ decks: [] });
      const revision = ++lists === 1 ? 1 : 2;
      return Response.json({ decks: [{ id: currentDeck.id, revision, updatedAt: revision * 10 }] });
    }
    if (url === `${ROOT}/${currentDeck.id}`) {
      if (++downloads === 1) {
        oldRequested();
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      return Response.json({ revision: 2, data: currentDeck });
    }
    return Response.json({ decks: [] });
  });
  const sync = await import('./deckSync');
  useSession.setState({ phase: 'signedIn', loginCount: 1, userName: 'Alice', serverUrl: SERVER });
  await started;
  useSession.setState({ phase: 'signedOut' });
  useSession.setState({ phase: 'signedIn', loginCount: 2, userName: 'Bob' });
  await vi.waitFor(() => expect(useDeckSyncStatus.getState()).toMatchObject({ ready: true, status: 'synced' }));
  useSession.setState({ phase: 'signedOut' });
  useSession.setState({ phase: 'signedIn', loginCount: 3, userName: 'Alice' });
  await vi.waitFor(() => expect(useDeckSyncStatus.getState()).toMatchObject({ ready: true, status: 'synced' }));
  releaseOld(Response.json({ revision: 1, data: oldDeck }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await deckStorage.loadDeck(currentDeck.id))?.name).toBe('Current Alice deck');
  await expect(sync.uploadNow(currentDeck.id)).resolves.toBeUndefined();
  expect(writes).toEqual([2]);
});

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
