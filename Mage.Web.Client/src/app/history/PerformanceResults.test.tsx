import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test } from 'vitest';
import { MatchupResults, MulliganResults } from './PerformanceResults';
import type { Performance } from './performance';
import { registerMessages, useI18n } from '../i18n';
import { ArchetypeSelect } from '../decks/ArchetypeSelect';
import { createTranslator } from '../i18n/translate';
import spanish from '../i18n/es';
import replay from '../i18n/en/replay';

registerMessages(replay);
afterEach(cleanup);

test('kept-hand and opposing card rows offer a preview independently of example replays', () => {
  const outcome = { wins: 1, losses: 0, draws: 0, total: 1 };
  const data = {
    coverage: { keptHands: 1, games: 1, opponentCards: 1 }, openingCards: [{ card: 'Mountain', games: outcome, without: outcome }],
    opponentCards: [{ card: 'Fatal Push', games: outcome, gameIds: ['one'] }], mulligans: [], matchups: [],
  } as unknown as Performance;
  render(<MemoryRouter><MulliganResults data={data} /><MatchupResults data={data} bo1 /></MemoryRouter>);
  for (const name of ['Mountain', 'Fatal Push']) {
    const row = screen.getByRole('row', { name: new RegExp(name) });
    const preview = within(row).getByRole('button', { name: new RegExp(name) });
    fireEvent.click(preview);
    expect(preview.getAttribute('aria-expanded')).toBe('true');
  }
  expect(screen.getByRole('link', { name: /Fatal Push/ }).getAttribute('href')).toBe('/replay/one');
});

test('sample size zero is neutral and rates vary continuously through the red, amber and green anchors', () => {
  const outcomes = [0, 25, 50, 75, 100].map(wins => ({ wins, losses: 100-wins, draws: 0, total: 100 }));
  const data = { coverage: {}, openingCards: [], mulligans: [
    ...outcomes, { total: 0, wins: 0, losses: 0, draws: 0 },
  ].map((games, count) => ({ games, count })) } as unknown as Performance;
  render(<MemoryRouter><MulliganResults data={data} /></MemoryRouter>);
  const styles = outcomes.map(({ wins }) => screen.getByText(wins + '%').getAttribute('style'));
  expect(styles.every(Boolean)).toBe(true);
  expect(new Set(styles).size).toBe(5);
  expect(screen.getByText('—').getAttribute('style')).toBeNull();
});

test('Spanish deck options translate practice labels and submit the stable archetype value', () => {
  const previous = useI18n.getState();
  try {
    useI18n.setState({ locale: 'es', t: createTranslator({ locale: 'es', messages: spanish, fallback: spanish }) });
    let value = '';
    render(<ArchetypeSelect format="Pioneer" archetype="Empty deck" onChange={next => { value = next; }} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('Empty deck');
    expect(select.options[select.selectedIndex].text).toBe('Mazo vacío');
    const practice = Array.from(select.options).find(option => option.text === 'Práctica con tierras básicas');
    expect(practice).toBeDefined();
    fireEvent.change(select, { target: { value: practice!.value } });
    expect(value).toBe('Basic Lands Practice');
  } finally {
    cleanup();
    useI18n.setState(previous);
  }
});
