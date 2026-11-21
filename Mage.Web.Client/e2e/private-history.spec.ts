import { expect, test } from '@playwright/test';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private build only');

const me = { name: 'Felipe', isMcp: false };
const opponent = { name: 'mcp_e70ebd2d48', displayName: 'Felipe', isMcp: true, model: 'gpt-5', reasoningEffort: 'high' };
const record = (wins: number, losses: number) => ({ wins, losses, draws: 0, total: wins + losses });
const deck = { id: 'family', name: 'BG testing', format: 'Pioneer', archetype: 'Golgari Midrange', currentVersion: 2, versions: [1, 2].map((version) => ({ version, format: 'Pioneer', archetype: 'Golgari Midrange' })) };
function performance(params: URLSearchParams) {
  const group = { deckIds: ['family'], format: 'Pioneer', archetype: 'Golgari Midrange', matches: record(6, 4), games: record(14, 11) };
  const shared = { ...group, deckIds: ['a', 'b'], archetype: 'Boros Energy', format: 'Modern', matches: record(0, 0), games: record(0, 0) };
  const otherDecks = shared.deckIds.map((id) => ({ ...deck, id, name: 'Boros ' + id, archetype: shared.archetype, format: shared.format,
    versions: [{ version: 2, format: shared.format, archetype: shared.archetype }] }));
  const isEmptyGroup = params.get('format') === 'Modern';
  const summary = isEmptyGroup ? shared : ['all', 'archetype'].includes(params.get('scope') || '') ? group
    : params.get('version') === '1' ? { matches: record(0, 1), games: record(1, 2) } : { matches: record(1, 0), games: record(2, 1) };
  return {
    decks: [deck, ...otherDecks], groups: params.get('format') === 'Standard' ? [] : [group, shared], selected: { deckId: 'family', version: 2 },
    summary, options: { ownArchetypes: ['Golgari Midrange'], opponentArchetypes: ['Izzet Phoenix'] },
    splits: { play: record(1, 0), draw: record(1, 1), preboard: record(0, 1), postboard: record(2, 0) },
    mulligans: isEmptyGroup ? [] : [{ count: 1, games: record(1, 0) }], openingCards: isEmptyGroup ? [] : [{ card: 'Thoughtseize', games: record(1, 1), without: record(0, 0) }, { card: 'Duress', games: record(1, 0), without: record(0, 1) }],
    matchups: [{ archetype: 'Izzet Phoenix', mulligans: { known: 3, taken: 1, opponentKnown: 2, opponentTaken: 0 }, matches: record(1, 0), games: record(2, 1) }],
    opponentCards: [{ card: 'Arclight Phoenix', games: record(1, 1), gameIds: ['replay-loss', 'replay-win'] }],
    coverage: isEmptyGroup ? { keptHands: 0, opponentCards: 0, games: 0 } : { keptHands: 2, opponentCards: 2, games: 3 }, matchIds: ['match-0'],
  };
}
const rivals = [opponent, { name: 'Camila' }, { name: 'Roberto' }, opponent, { name: 'Valentina' }, { name: 'Camila' }];
const matches = rivals.map((rival, index) => {
  const winner = index % 3 === 0 ? me.name : rival.name;
  return {
    id: 'match-' + index, name: 'Practice', format: index === 3 ? 'Modern' : 'Pioneer', status: 'completed',
    winner, startedAt: Date.UTC(2026, 10, 21 - index, 17, 10),
    games: [1, 2, 3].map((gameNumber) => ({
      gameId: index + '-' + gameNumber, gameNumber, viewerName: 'felipe', winner: gameNumber === 1 ? (winner === me.name ? rival.name : me.name) : winner,
      players: [me, rival], startPlayer: rival.name, turns: 8, ownMulligans: 0, archiveState: 'ready', replayAvailable: true,
    })),
  };
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  test.describe(`history ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    test('deck performance, version filters, seat, export and an empty format', async ({ page, baseURL }, info) => {
      expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL!).hostname);
      await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'es', sound: false, animations: false })));
      let exported: string[] = [];
      await page.route('**/api/playtesting/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/exports')) {
          exported = route.request().postDataJSON().gameIds;
          return route.fulfill({ body: 'synthetic fixture', contentType: 'application/zip' });
        }
        const empty = url.searchParams.get('format') === 'Standard';
        const result = url.pathname.endsWith('/me') ? { engineName: 'Felipe', agent: false }
          : url.pathname.endsWith('/matches') ? { matches: empty ? [] : matches, cursor: null }
          : url.pathname.endsWith('/performance') ? performance(url.searchParams) : {};
        return route.fulfill({ json: result });
      });
      await page.routeWebSocket(/\/ws$/, (socket) => socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.id === undefined) return;
        const results: Record<string, unknown> = {
          connectUser: true, sessionUserName: 'Felipe', sessionGetRestoreToken: '',
          serverGetMainRoomId: '00000000-0000-4000-8000-0000000000aa',
          serverInfo: { signOn: 'Felipe', signOnOnly: true, deckSync: true, accounts: false, serverName: 'Synthetic private server' },
          getServerState: { serverVersion: 'fixture', maxGameRuns: 0, cardInfo: [] },
        };
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] ?? null }));
      }));
      await page.goto('/history');
      const opener = page.getByRole('button', { name: /Felipe MCP.*Victoria/i }).first();
      await expect(opener).toHaveAttribute('aria-expanded', 'false');
      await expect(opener).toContainText('2–1');
      const card = page.getByRole('link', { name: /Golgari Midrange/ });
      await expect(card).toContainText('Pioneer');
      await expect(card).toContainText(/60\s?%/);
      await card.click();
      await expect(page.getByRole('heading', { name: 'Golgari Midrange' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Mazo', exact: true })).toHaveValue('');
      await expect(page.getByRole('region', { name: 'Partidas ganadas' })).toContainText('6/10');
      await expect(page.getByRole('region', { name: 'Partidas ganadas' })).toContainText(/60\s?%/);
      await expect(page.getByRole('combobox', { name: 'Versión' })).toHaveCount(0);
      await page.getByRole('combobox', { name: 'Mazo', exact: true }).selectOption('family');
      await expect(page.getByRole('combobox', { name: 'Versión' })).toHaveValue('2');
      await page.getByRole('combobox', { name: 'Modalidad' }).selectOption('3');
      await expect(page.getByRole('region', { name: 'Partidas ganadas' })).toContainText(/100\s?%/);
      await expect(page.getByRole('region', { name: 'Juegos ganados' })).toContainText(/67\s?%/);
      await page.getByRole('combobox', { name: 'Versión' }).selectOption('1');
      await expect(page.getByRole('region', { name: 'Partidas ganadas' })).toContainText('0/1');
      await page.getByRole('combobox', { name: 'Versión' }).selectOption('2');
      await page.getByRole('tab', { name: 'Mulligan' }).click();
      await expect(page.getByRole('tabpanel')).toContainText('2 de 3 juegos con mano conservada registrada');
      await expect(page.getByRole('row', { name: /Thoughtseize/ })).toContainText(/50\s?%/);
      const openingTable = page.getByRole('table', { name: 'Cartas en tu mano conservada' });
      await expect(openingTable.getByRole('row').nth(1)).toContainText('Thoughtseize');
      const thoughtseize = openingTable.getByRole('row', { name: /Thoughtseize/ });
      await expect(thoughtseize.getByRole('cell').nth(0)).toContainText('(1/2)');
      await expect(thoughtseize.getByRole('cell').nth(1)).toContainText('— (0/0)');
      const duress = openingTable.getByRole('row', { name: /Duress/ });
      await expect(duress.getByRole('cell').nth(0)).toContainText(/100\s?%.*1\/1/);
      await expect(duress.getByRole('cell').nth(1)).toContainText(/0\s?%.*0\/1/);
      await openingTable.getByRole('button', { name: 'Con la carta' }).click();
      await expect(openingTable.getByRole('row').nth(1)).toContainText('Duress');
      await page.screenshot({ path: info.outputPath(`mulligan-${viewport.width}.png`), animations: 'disabled' });
      await page.getByRole('tab', { name: 'Matchups' }).click();
      await expect(page.getByRole('table', { name: 'Resultados por arquetipo rival' }).getByRole('row', { name: /Izzet Phoenix/ })).toBeVisible();
      const phoenix = page.getByRole('row', { name: /Arclight Phoenix/ });
      await expect(phoenix.getByRole('link')).toHaveCount(2);
      await expect(phoenix.getByRole('link').first()).toHaveAttribute('href', '/replay/replay-loss');
      await phoenix.getByRole('link').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`analisis-${viewport.width}.png`), animations: 'disabled' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('tab', { name: 'Resumen' }).click();
      await page.getByRole('combobox', { name: 'Modalidad' }).selectOption('1');
      await expect(page.getByRole('region', { name: 'Partidas ganadas' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Juegos ganados' })).toHaveCount(0);
      await page.getByRole('combobox', { name: 'Versión' }).selectOption('');
      await expect(page).toHaveURL(/scope=deck/);
      await page.getByRole('combobox', { name: 'Mazo', exact: true }).selectOption('');
      await expect(page).toHaveURL(/scope=archetype/);
      await expect(page.getByRole('combobox', { name: 'Versión' })).toHaveCount(0);
      await page.getByRole('combobox', { name: 'Arquetipo rival' }).selectOption('unknown');
      await expect(page).toHaveURL(/opponentArchetypeUnknown=true/);
      await page.reload();
      await expect(page.getByRole('combobox', { name: 'Arquetipo rival' })).toHaveValue('unknown');
      await page.getByRole('link', { name: 'Volver al historial' }).click();
      await expect(opener).toBeVisible();
      await page.getByRole('link', { name: /Boros Energy/ }).click();
      await expect(page.getByRole('combobox', { name: 'Mazo', exact: true })).toHaveValue('');
      await expect(page.getByRole('region', { name: 'Partidas ganadas' })).toContainText('—');
      await page.getByRole('combobox', { name: 'Mazo', exact: true }).selectOption('b');
      await expect(page.getByRole('combobox', { name: 'Versión' })).toHaveValue('2');
      await page.getByRole('tab', { name: 'Mulligan' }).click();
      await expect(page.getByRole('tabpanel')).toContainText('0 de 0 juegos con mano conservada registrada');
      await page.getByRole('link', { name: 'Volver al historial' }).click();
      await expect(page.getByRole('button', { name: 'Replay', exact: true })).toHaveCount(0);
      await page.evaluate(async () => { await document.fonts.ready; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`historial-${viewport.width}.png`), animations: 'disabled' });
      await opener.focus();
      await opener.press('Enter');
      await expect(opener).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByText('gpt-5').first()).toBeVisible();
      await expect(page.getByText('high').first()).toBeVisible();
      await expect(page.getByText('mcp_e70ebd2d48')).toHaveCount(0);
      await page.getByRole('checkbox', { name: 'Seleccionar juego 2' }).check();
      await opener.click();
      await page.getByRole('button', { name: /Descargar selección.*1/ }).click();
      expect(exported).toEqual(['0-2']);
      await page.getByRole('combobox', { name: 'Formato' }).selectOption('Standard');
      await expect(page.getByText('Todavía no hay partidas en este formato.')).toBeVisible();
      await expect(page.getByRole('button', { name: /Descargar selección/ })).toBeDisabled();
    });
  });
}
