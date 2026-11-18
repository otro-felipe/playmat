import { expect, test } from '@playwright/test';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private invitations only');
test.beforeEach(({ baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw Error('Coach UI QA requires an isolated loopback server');
});
const tableId = '11111111-1111-4111-8111-111111111111';
const roomId = '22222222-2222-4222-8222-222222222222';

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width < 1000, isMobile: viewport.width < 1000 });
    test('the real invitation explains and copies warm, bounded Coach instructions without joining a match', async ({ page }) => {
      const gameActions: string[] = [];
      await page.addInitScript(() => {
        localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'es', sound: false, animations: false }));
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Synthetic clipboard refusal'); } } });
      });
      await page.route('**/api/playtesting/**', (route) => {
        const url = new URL(route.request().url());
        return route.fulfill({ json: url.pathname.endsWith('/me') ? { engineName: 'Alice', agent: false }
          : url.pathname.includes('/invites/') ? { tableId, mode: 'mcp', chatMode: 'coach' } : { decks: [] } });
      });
      await page.routeWebSocket(/\/ws$/, (socket) => socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.id === undefined) return;
        if (message.method.startsWith('sendPlayer') || message.method === 'roomJoinTable') gameActions.push(message.method);
        const replies: Record<string, unknown> = {
          connectUser: true, sessionUserName: 'Alice', sessionGetRestoreToken: '', serverGetMainRoomId: roomId,
          serverInfo: { signOn: 'Alice', deckSync: true, accounts: false },
          getServerState: { serverVersion: 'fixture', maxGameRuns: 0, cardInfo: [] },
          roomGetAllTables: [{ tableId, tableName: 'Mesa Coach sintética', controllerName: 'Alice', tableState: 'WAITING', seats: [] }],
        };
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: replies[message.method] ?? null }));
      }));
      await page.goto(`/join/${tableId}`);
      await expect(page.getByRole('heading', { name: 'Mesa Coach sintética' })).toBeVisible();
      await expect(page.getByText(/Señala buenas oportunidades públicas/)).toBeVisible();
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.screenshot({ path: test.info().outputPath(`coach-overview-${viewport.width}.png`) });
      const copy = page.getByRole('button', { name: 'Copiar instrucciones', exact: true });
      await copy.click();
      const text = page.getByRole('textbox', { name: 'Instrucciones para el agente' });
      await expect(text).toBeVisible();
      const instructions = await text.inputValue();
      await expect(text).toHaveAttribute('readonly', '');
      for (const detail of ['después de cada turno humano completado', 'sin usar resultados posteriores', 'Coach no da acceso a la mano', 'Resuelve primero las decisiones pendientes del motor', 'send_chat']) {
        expect(instructions.toLowerCase()).toContain(detail.toLowerCase());
      }
      for (const control of [copy, text]) {
        const box = await control.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(gameActions).toEqual([]);
      await text.scrollIntoViewIfNeeded();
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.screenshot({ path: test.info().outputPath(`coach-invite-${viewport.width}.png`) });
    });
  });
}
