import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useDecks, type RosterDeck } from './decks';
import { useDeckRoster } from './useDeckRoster';
import { useDeckSyncStatus } from './deckSyncStatus';
import { DEFAULT_SETTINGS, useSettings, toUserData } from './settings';
import { useManaPaymentSettings } from '../match/useManaPaymentSettings';
import type { GameSession } from '../../core/game/gameSession';
import { deckStorage } from '../../core/decks/DeckStorageService';

vi.mock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
vi.mock('../connection', async () => (await import('../../test/fakeConnection')).createFakeConnection());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const own: RosterDeck = { id: 'own', name: 'My saved deck', note: '', cardCount: 60, cover: null, colors: [], starter: null, tags: [], draft: false };
const agent = { ...own, id: 'agent', name: 'MCP reusable deck', library: 'agent' as const };

test('private pickers start empty while loading, then separate own decks and MCP decks without starters', () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hideStarterDecks: false } });
  useDecks.setState({ saved: [own, agent], starters: [{ file: 'red.dck', name: 'Starter', cards: 60, cover: { name: 'Shock', setCode: 'M19', cardNumber: '1' } }] });
  useDeckSyncStatus.setState({ ready: false });
  const personal = renderHook(() => useDeckRoster());
  const opponent = renderHook(() => useDeckRoster('agent'));
  expect(personal.result.current).toEqual([]);
  expect(opponent.result.current).toEqual([]);
  act(() => useDeckSyncStatus.setState({ ready: true }));
  expect(personal.result.current.map((deck) => deck.id)).toEqual(['own']);
  expect(opponent.result.current.map((deck) => deck.id)).toEqual(['agent']);
  expect(useDecks.getState().saved).toEqual([own, agent]);
});

test('refresh with zero private decks never fetches or selects a shipped starter', async () => {
  const fetcher = vi.fn<(url: string) => Promise<Response>>(async () => Response.json({ decks: [] }));
  vi.stubGlobal('fetch', fetcher);
  useDecks.setState({ starters: [], metaDecks: [], selectedId: 'starter:red.dck' });
  await useDecks.getState().refresh();
  expect(useDecks.getState()).toMatchObject({ saved: [], starters: [], selectedId: null, loaded: true });
  expect(fetcher.mock.calls.some(([path]) => String(path).includes('/starter-decks/'))).toBe(false);
});

test('private payment stays manual even with old auto-pay, pool and streamlined preferences', async () => {
  const settings = { ...DEFAULT_SETTINGS, autoPayMana: true, autoPayRestricted: false };
  useSettings.setState({ settings, fullControl: false });
  expect(toUserData(settings)).toMatchObject({ manaPoolAutomatic: false, manaPoolAutomaticRestricted: true });
  const respond = vi.fn(async () => {});
  renderHook(() => useManaPaymentSettings({ respond } as unknown as GameSession, true));
  await act(async () => {});
  expect(respond.mock.calls).toEqual([
    [{ type: 'action', action: 'MANA_AUTO_PAYMENT_RESTRICTED_ON' }],
    [{ type: 'action', action: 'MANA_AUTO_PAYMENT_OFF' }],
  ]);
  expect(useSettings.getState().settings).toEqual(settings);
});

test('copying an MCP deck creates a personal copy while preserving the reusable original', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ decks: [] })));
  const original = { id: 'rival-deck', name: 'Rival Burn', library: 'agent' as const, cards: [{ cardName: 'Mountain', amount: 60 }], sideboard: [] };
  deckStorage.importFromSync(original.id, JSON.stringify(original));
  await useDecks.getState().refresh();
  const id = await useDecks.getState().duplicate(original.id);
  const copy = await deckStorage.loadDeck(id);
  expect(id).not.toBe(original.id);
  expect(copy?.library ?? 'personal').toBe('personal');
  expect(copy?.cards).toEqual(original.cards);
  expect((await deckStorage.loadDeck(original.id))?.library).toBe('agent');
  expect(useDecks.getState().saved).toHaveLength(2);
});
