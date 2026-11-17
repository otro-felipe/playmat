import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from '../connection';
import { queryClient } from '../queries';
import { useEvents } from '../stores/events';
import { BuildScreen } from './BuildScreen';

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  useEvents.setState({ construct: null });
});

test('[PM-AC-06] the private sideboard submits the exact game-two list and shows readiness', async () => {
  const plains = { name: 'Plains', expansionSetCode: 'M21', cardNumber: '260' };
  const island = { id: 'island', name: 'Island', expansionSetCode: 'M21', cardNumber: '265' };
  const cards = Object.fromEntries(Array.from({ length: 60 }, (_, i) => {
    const id = `plains-${i}`;
    return [id, { ...plains, id }];
  }));
  const original = { name: 'Test deck', cards, sideboard: { island } };
  useEvents.setState({ construct: {
    tableId: 'duel', parentTableId: null, kind: 'sideboard', limited: false, deadline: null, submitted: false,
    deck: original,
  } });
  const submit = vi.spyOn(api, 'submitDeck').mockResolvedValue(true);
  const page = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/build/duel']}>
        <Routes><Route path="/build/:tableId" element={<BuildScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const pool = page.getByRole('region', { name: 'Sideboard, 1 card' });
  fireEvent.click(within(pool).getByRole('button', { name: 'Island' }));
  const main = page.getByRole('region', { name: 'Deck, 61 cards' });
  fireEvent.click(within(main).getAllByRole('button', { name: 'Plains' })[0]);
  await act(async () => fireEvent.click(page.getByRole('button', { name: 'Submit deck' })));
  expect(submit).toHaveBeenCalledExactlyOnceWith('duel', {
    name: 'Event deck',
    cards: expect.arrayContaining([
      { cardName: 'Plains', setCode: 'M21', cardNumber: '260', amount: 59 },
      { cardName: 'Island', setCode: 'M21', cardNumber: '265', amount: 1 },
    ]),
    sideboard: [{ cardName: 'Plains', setCode: 'M21', cardNumber: '260', amount: 1 }],
  });
  expect(page.getByText('Deck submitted — waiting for the others')).toBeTruthy();
  expect(Object.keys(original.cards)).toHaveLength(60);
  expect(Object.keys(original.sideboard)).toEqual(['island']);
});
