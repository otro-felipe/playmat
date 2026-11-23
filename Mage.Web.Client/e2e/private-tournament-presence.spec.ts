import { expect, test } from '@playwright/test';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private build only');

test('an organizer can keep the administration open while the separate human game tab checks in after reload', async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw Error('Loopback required');
  const event = {
    id: 'cup',
    name: 'Friday Cup',
    status: 'registration',
    capacity: 8,
    cut: 'none',
    template: 'attendance',
    stage: 'registration',
    format: 'Standard',
    roundNumber: 0,
    roundsTotal: 3,
    cutSize: 0,
    participants: [
      { id: 'human', kind: 'human', name: 'Felipe', owner: 'Felipe', state: 'registered', online: true },
      { id: 'pilot', kind: 'agent', name: 'Luna', owner: 'Felipe', state: 'registered', online: false },
    ],
    standings: [],
    pairings: [],
    viewer: { accountName: 'Felipe', isAdmin: true, entryIds: ['human', 'pilot'] },
  };
  const beats: { pageUrl: string; body: unknown }[] = [];
  await context.route('**/api/playtesting/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events'))
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' });
    if (path.endsWith('/wait')) {
      beats.push({ pageUrl: route.request().frame().url(), body: route.request().postDataJSON() });
      return route.fulfill({ json: { entryId: 'human', status: 'registration' } });
    }
    return route.fulfill({
      json: path.endsWith('/me')
        ? { engineName: 'Felipe', agent: false }
        : path.endsWith('/tournaments/cup')
          ? event
          : { decks: [] },
    });
  });
  await context.routeWebSocket(/\/ws$/, (socket) =>
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.id === undefined) return;
      const responses: Record<string, unknown> = {
        connectUser: true,
        sessionUserName: 'Felipe',
        sessionGetRestoreToken: '',
        serverGetMainRoomId: '00000000-0000-4000-8000-0000000000aa',
        serverInfo: { signOn: 'Felipe', signOnOnly: true, deckSync: true, accounts: false, serverName: 'Fixture' },
        getServerState: { serverVersion: 'fixture', maxGameRuns: 0, cardInfo: [] },
      };
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: responses[message.method] ?? null }));
    }),
  );
  await page.goto('/tournaments/cup/admin');
  const play = page.getByRole('link', { name: /play at my table|jugar en mi mesa/i });
  await expect(play).toHaveAttribute('target', '_blank');
  expect(beats).toHaveLength(0);
  const [game] = await Promise.all([context.waitForEvent('page'), play.click()]);
  await expect.poll(() => beats.length).toBe(1);
  await expect(page).toHaveURL(/\/tournaments\/cup\/admin$/);
  await expect(game).toHaveURL(/\/$/);
  await game.reload();
  await expect.poll(() => beats.length).toBe(2);
  expect(beats.every((beat) => !beat.pageUrl.includes('/admin') && JSON.stringify(beat.body) === '{}')).toBe(true);
  await expect(page.getByRole('heading', { name: 'Friday Cup' })).toBeVisible();
});
