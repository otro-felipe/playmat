import { expect, test } from '@playwright/test';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private build only');
test.beforeEach(({ baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw Error('Bootstrap smoke tests require loopback');
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
    test('the actual private app boots with one login, no starter decks and restricted mana payment', async ({ page }) => {
      const logins: { name: string; passwordProvided: boolean }[] = [];
      const preferences: { automatic: boolean; restricted: boolean }[] = [];
      const starters: string[] = [];
      await page.addInitScript(() => {
        localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'es', sound: false, animations: false, autoPayMana: true, autoPayRestricted: false }));
        localStorage.setItem('playmat.login', JSON.stringify({ userName: 'StaleName', serverUrl: 'wss://old.example/ws', passwordless: true }));
        Object.assign(window, { engineFormSeen: false });
        new MutationObserver(() => {
          if (document.querySelector('input[autocomplete="username"], input[type="password"]')) Object.assign(window, { engineFormSeen: true });
        }).observe(document, { subtree: true, childList: true });
      });
      page.on('request', (request) => { if (request.url().includes('/starter-decks/')) starters.push(request.url()); });
      await page.route('**/api/playtesting/**', (route) => route.fulfill({ json: route.request().url().endsWith('/me') ? { engineName: 'Alice', agent: false } : { decks: [] } }));
      await page.routeWebSocket(/\/ws$/, (socket) => {
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.id === undefined) return;
          if (message.method === 'connectUser') logins.push({ name: message.params[0], passwordProvided: !!message.params[1] });
          if (message.method === 'connectSetUserData') preferences.push({ automatic: message.params[2].manaPoolAutomatic, restricted: message.params[2].manaPoolAutomaticRestricted });
          const results: Record<string, unknown> = {
            connectUser: true, sessionUserName: 'Alice', sessionGetRestoreToken: '',
            serverGetMainRoomId: '00000000-0000-4000-8000-0000000000aa',
            serverInfo: { signOn: 'Alice', signOnOnly: true, deckSync: true, accounts: false, serverName: 'Synthetic private server' },
            getServerState: { serverVersion: 'fixture', maxGameRuns: 0, cardInfo: [] },
          };
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] ?? null }));
        });
      });
      await page.goto('/decks');
      await expect(page.getByRole('button', { name: 'Mis mazos', exact: true })).toBeVisible();
      await expect(page.getByText(/Trae un mazo que ya tengas/)).toBeVisible();
      expect(logins).toEqual([{ name: 'Alice', passwordProvided: false }]);
      await expect.poll(() => preferences.length).toBeGreaterThan(0);
      expect(preferences).toEqual(preferences.map(() => ({ automatic: true, restricted: true })));
      expect(starters).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { engineFormSeen: boolean }).engineFormSeen)).toBe(false);
      await page.getByRole('button', { name: 'Rival IA · MCP', exact: true }).click();
      await expect(page.getByText(/Todavía no hay mazos del rival MCP/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rival IA · MCP', exact: true }).locator('span')).toHaveCSS('color', 'rgb(29, 20, 6)');
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.screenshot({ path: test.info().outputPath(`private-app-${viewport.width}.png`) });
    });
  });
}
