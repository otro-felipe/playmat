import { expect, test } from '@playwright/test';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private build only');

const me = { name: 'Felipe', isMcp: false };
const opponent = { name: 'mcp_e70ebd2d48', displayName: 'Felipe', isMcp: true, model: 'gpt-5', reasoningEffort: 'high' };
const decks = [
  { deckName: 'Golgari Midrange', format: 'Pioneer', deckVersion: 'c710feed', games: 14, wins: 8 },
  { deckName: 'Golgari Midrange', format: 'Pioneer', deckVersion: 'ae62bbee', games: 7, wins: 3 },
  { deckName: 'Boros Energy', format: 'Modern', deckVersion: 'b0137ecc', games: 4, wins: 3 },
].map((deck) => ({ ...deck, onPlay: 2, onDraw: 1, averageMulligans: 0.6, averageTurns: 10 }));
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
    test('one line per match, correct seat, game-level export and a filtered empty state', async ({ page, baseURL }, info) => {
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
          : url.pathname.endsWith('/stats') ? { groups: empty ? [] : decks, totals: empty ? { matches: 0, games: 0, wins: 0 } : { matches: 12, games: 25, wins: 14 } } : {};
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
      await expect(page.getByText(/Golgari Midrange.*c710fe/)).toHaveCount(1);
      await expect(page.getByRole('region', { name: 'Resumen' })).toContainText(/56\s?%/);
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
