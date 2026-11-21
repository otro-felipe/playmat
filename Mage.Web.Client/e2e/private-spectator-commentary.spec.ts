import { expect, test } from '@playwright/test';
import { spectatorSnapshot, spectatorToken } from './fixtures/spectatorSnapshot';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private playtesting routes');
test('a broadcast places audience commentary on the correct seat and interleaves it with table chat', async ({ page, baseURL }) => {
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL!).hostname);
  await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'es', animations: false })));
  let sent = false;
  const players = spectatorSnapshot.players.map((p, i) => ({ ...p, name: i ? 'Piloto2' : 'Piloto' }));
  const view = { ...spectatorSnapshot.view, players: spectatorSnapshot.view.players.map((player, i) => ({ ...player, name: players[i].name })) };
  const initial = { ...spectatorSnapshot, players, view };
  await page.route('**/api/playtesting/spectate/**', async route => {
    if (!route.request().url().endsWith('/events')) return route.fulfill({ json: initial });
    const at = Date.now();
    const chat = [{ at: at - 2, messageId: 'id', playerName: 'Piloto', message: 'Buena jugada.' }];
    const lines = [{ at, turn: 3, lineId: 'id', playerName: 'Piloto2', playerId: 'seat-b', reasoning: 'Reservo [Bosque](card://Forest).' }];
    const event = 'event: snapshot\ndata: ' + JSON.stringify({ ...initial, chat, lines }) + '\n\n';
    sent = true;
    return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 30000\n\n' + event + event });
  });
  await page.goto('/watch/' + spectatorToken);
  const upper = page.locator('[data-object-id="seat-b"]');
  const bubble = upper.getByRole('status', { name: 'Comentario para la audiencia' });
  await expect(bubble.getByText(/Reservo/)).toBeVisible();
  expect(sent).toBeTruthy();
  await expect(page.locator('[data-object-id="seat-a"]').getByText(/Reservo/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const list = page.locator('aside').filter({ has: page.getByRole('heading', { name: 'Chat', exact: true }) }).getByRole('list');
  const entries = list.getByRole('listitem');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText('Chat de mesa');
  await expect(entries.nth(0)).toContainText('Piloto · Asiento 1');
  await expect(entries.nth(1)).toContainText('Comentario para la audiencia');
  await expect(entries.nth(1)).toContainText('Piloto2 · Asiento 2');
  await entries.nth(1).getByRole('button', { name: /Bosque/ }).click();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('opening an English broadcast directly provides both hand labels without loading a replay', async ({ page, baseURL }) => {
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL!).hostname);
  await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'en', animations: false })));
  await page.route('**/api/playtesting/spectate/**', route => route.request().url().endsWith('/events')
    ? route.fulfill({ contentType: 'text/event-stream', body: 'retry: 30000\n\n' })
    : route.fulfill({ json: spectatorSnapshot }));
  await page.goto('/watch/' + spectatorToken);
  await expect(page.getByRole('group', { name: 'Bob’s hand' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Alice’s hand' })).toBeVisible();
});
