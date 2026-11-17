import { beforeEach, describe, expect, it, vi } from 'vitest';

const deck = { name: 'Elves', cards: [{ cardName: 'Llanowar Elves', setCode: 'M19', cardNumber: '314', amount: 4 }], sideboard: [] };
const warmDeck = vi.fn();
const roomJoinTable = vi.fn(async () => true);
const loadForPlay = vi.fn(async () => ({ deck, id: 'd1' }));

vi.mock('../connection', () => ({ api: { roomJoinTable: (...args: unknown[]) => roomJoinTable(...(args as [])) } }));
vi.mock('../queries', () => ({ refreshTables: vi.fn() }));
vi.mock('../stores/decks', () => ({ useDecks: { getState: () => ({ loadForPlay }) } }));
vi.mock('../stores/session', () => ({ useSession: { getState: () => ({ roomId: 'room', userName: 'me' }) } }));
vi.mock('../ui/imageCache', () => ({ warmDeck: (value: unknown) => warmDeck(value) }));

describe('joinTable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warms the deck before taking the seat', async () => {
    const { joinTable } = await import('./joinTable');
    await joinTable({ tableId: 't1' }, 'd1');
    expect(warmDeck).toHaveBeenCalledWith(deck);
    expect(warmDeck.mock.invocationCallOrder[0]).toBeLessThan(roomJoinTable.mock.invocationCallOrder[0]);
  });

  it('stops before taking the seat when cancelled while preparing the deck', async () => {
    const { joinTable } = await import('./joinTable');
    const controller = new AbortController();
    loadForPlay.mockImplementationOnce(async () => {
      controller.abort();
      return { deck, id: 'd1' };
    });
    await expect(joinTable({ tableId: 't1' }, 'd1', '', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(warmDeck).not.toHaveBeenCalled();
    expect(roomJoinTable).not.toHaveBeenCalled();
  });
});
