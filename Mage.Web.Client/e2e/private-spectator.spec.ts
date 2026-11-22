import { expect, test } from '@playwright/test';
import { spectatorSnapshot, spectatorToken } from './fixtures/spectatorSnapshot';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private playtesting routes');
test.beforeEach(async ({ page, baseURL }) => {
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL!).hostname);
  await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({
    locale: 'es', animations: false, matArt: 'none', hideHands: true,
  })));
});

for (const viewport of [{ width: 1512, height: 805 }, { width: 390, height: 844 }]) {
  test.describe(`spectator ${viewport.width}px`, () => {
    test.use({ viewport });
    test('a public link opens the real board with two visible hands and no player connection', async ({ page }, info) => {
      const privateRequests: string[] = [];
      page.on('websocket', socket => {
        const path = new URL(socket.url()).pathname;
        // Vite's development hot reload is separate from the game transport.
        if (path !== '/' || process.env.MAGE_WEB_E2E_PREVIEW === '1') privateRequests.push(path);
      });
      await page.route('**/api/playtesting/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/playtesting/spectate/' + spectatorToken) return route.fulfill({ json: spectatorSnapshot });
        if (path.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 5000\n\n' });
        privateRequests.push(path);
        return route.fulfill({ status: 403, json: {} });
      });
      await page.goto('/watch/' + spectatorToken);
      const header = page.getByRole('banner', { name: 'Transmisión de la partida' });
      await expect(header.getByRole('heading', { name: 'Modo espectador' })).toBeVisible();
      await expect(page.getByRole('listitem', { name: 'Forest', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Lightning Bolt', exact: true })).toBeVisible();
      const stage = page.locator('[data-layout]').first();
      await expect(stage).toBeVisible();
      const toolbarBox = await header.boundingBox();
      const boardBox = await stage.locator('..').boundingBox();
      expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(boardBox!.y + 1);
      await expect(page.getByRole('button', { name: /Concede|Conceder|Game menu|Actualizar tablero|Ask to see/i })).toHaveCount(0);
      await page.keyboard.press('Space');
      expect(privateRequests).toEqual([]);
      for (const handCard of [page.getByRole('listitem', { name: 'Forest', exact: true }), page.getByRole('button', { name: 'Lightning Bolt', exact: true })]) {
        await expect.poll(() => handCard.evaluate(card => {
          const image = card.querySelector('img');
          const frame = card.querySelector('[class*="titleBar"]')?.parentElement;
          return !!(image?.complete && image.naturalWidth || frame && Number(getComputedStyle(frame).opacity) > 0.95);
        })).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`espectador-${viewport.width}.png`) });
    });
  });
}

test('the public MCP board shows held cards as backs from their public counts', async ({ page }) => {
  const frame = { ...spectatorSnapshot, visibility: 'public-board', hands: {}, lines: [], chat: [] };
  await page.route('**/api/playtesting/spectate/**', route => route.request().url().endsWith('/events')
    ? route.fulfill({ contentType: 'text/event-stream', body: 'retry: 5000\n\n' })
    : route.fulfill({ json: frame }));
  await page.goto('/watch/' + spectatorToken);
  await expect(page.getByRole('listitem', { name: 'Hidden card', exact: true })).toHaveCount(1);
  await expect(page.getByRole('listitem', { name: 'Forest', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lightning Bolt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copiar enlace de espectador' })).toHaveAttribute('title', /tablero/i);
});

test('an expired spectator link shows a clear message without visiting player login', async ({ page }) => {
  await page.route('**/api/playtesting/spectate/**', route => route.fulfill({ status: 404, json: {} }));
  await page.goto('/watch/' + spectatorToken);
  await expect(page.getByText('Este enlace de espectador ya no está disponible.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp('/watch/' + spectatorToken + '$'));
});

test('the delegated owner watches both hands and creates the share link on request', async ({ page, context, baseURL }) => {
  const { gameId, tableId } = spectatorSnapshot;
  const frame = { ...spectatorSnapshot, humanMcpName: 'Alice',
    players: [spectatorSnapshot.players[0], { ...spectatorSnapshot.players[1], name: 'mcp_guest', displayName: 'Merlín' }],
    view: { ...spectatorSnapshot.view, players: [spectatorSnapshot.view.players[0], { ...spectatorSnapshot.view.players[1], name: 'mcp_guest' }] },
  };
  const posts: string[] = [];
  let startGame: (() => void) | undefined;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/playtesting/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/spectator-link')) {
      posts.push(route.request().method() + ' ' + path);
      return route.fulfill({ json: { path: '/watch/' + spectatorToken } });
    }
    if (path.endsWith('/spectator') || path.endsWith('/spectate/' + spectatorToken)) return route.fulfill({ json: frame });
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 5000\n\n' });
    if (path.endsWith('/human-seat/' + tableId)) return route.fulfill({ json: { tableId, humanName: 'Alice', humanMcpAllowed: true } });
    return route.fulfill({ json: path.endsWith('/me') ? { engineName: 'Alice', agent: false } : { decks: [] } });
  });
  await page.routeWebSocket(/\/ws$/, socket => {
    socket.onMessage(raw => {
      const rpc = JSON.parse(String(raw));
      if (rpc.id === undefined) return;
      const result: Record<string, unknown> = { connectUser: true, sessionUserName: 'Alice', sessionGetRestoreToken: '',
        serverGetMainRoomId: '00000000-0000-4000-8000-0000000000aa', serverInfo: { signOn: 'Alice', signOnOnly: true },
        getServerState: { serverVersion: 'fixture', cardInfo: [] } };
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: result[rpc.method] ?? null }));
    });
    startGame = () => socket.send(JSON.stringify({ method: 'START_GAME', messageId: 1, objectId: tableId,
      data: { currentTableId: tableId, gameId, playerId: 'seat-a' } }));
  });
  await page.goto('/decks');
  await expect(page.getByRole('button', { name: 'Mis mazos', exact: true })).toBeVisible();
  startGame!();
  await expect(page).toHaveURL(new RegExp('/game/' + gameId));
  await expect(page.getByRole('button', { name: 'Lightning Bolt', exact: true })).toBeVisible();
  await expect(page.getByText(/Jugador controlado por MCP · Solo lectura/)).toBeVisible();
  const humanPlate = page.locator('[data-object-id="seat-a"]');
  const rivalPlate = page.locator('[data-object-id="seat-b"]');
  await expect(humanPlate).toContainText('Alice');
  await expect(humanPlate).toContainText('MCP habilitado');
  await expect(rivalPlate).toContainText('Merlín');
  await expect(rivalPlate).toContainText('MCP');
  expect(posts).toEqual([]);
  await page.getByRole('button', { name: 'Copiar enlace de espectador' }).click();
  expect(posts).toEqual(['POST /api/playtesting/tables/' + tableId + '/spectator-link']);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(baseURL + '/watch/' + spectatorToken);
  await page.goto('/watch/' + spectatorToken);
  await expect(humanPlate).toContainText('MCP habilitado');
  await expect(rivalPlate).toContainText('Merlín');
});
