import { expect, test } from '@playwright/test';
import { spectatorSnapshot } from './fixtures/spectatorSnapshot';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private playtesting routes');

for (const width of [1440, 390]) {
  test(`the live tournament header and recent land fit at ${width}px`, async ({ page, baseURL }, info) => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(baseURL!).hostname);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'es', animations: false })));
    const land = {
      id: 'new-land', name: 'Island', cardTypes: ['LAND'], zone: 'BATTLEFIELD', summoningSickness: true,
    };
    await page.route('**/api/playtesting/tournaments/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 30000\n\n' });
      if (!url.pathname.endsWith('/watch')) return route.fulfill({ json: { viewer: null } });
      return route.fulfill({ json: {
        ...spectatorSnapshot,
        visibility: 'public-board',
        deadlineAt: Date.now() + 49 * 60_000,
        matchScore: [{ name: 'Alice', wins: 1 }, { name: 'Bob', wins: 0 }],
        view: { ...spectatorSnapshot.view, players: spectatorSnapshot.view.players.map((seat, index) =>
          index === 0 ? { ...seat, battlefield: { [land.id]: land } } : seat) },
      } });
    });
    await page.goto('/tournaments/sample/pairings/example/watch');
    const header = page.getByRole('banner');
    await expect(header.getByText('En vivo · 2 viendo')).toBeVisible();
    const score = header.getByRole('group', { name: 'Marcador de la partida' });
    await expect(score).toBeVisible();
    await expect(score.getByText('1–0')).toBeVisible();
    await expect(header.getByText('Reloj de mesa')).toBeVisible();
    await expect(header.locator('time')).toHaveText(/^(48|49):[0-5][0-9]$/);
    const badge = page.locator('[data-object-id=new-land]').getByRole('img', { name: 'Control reciente' });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('title', /mareo de invocación si se anima/);
    expect(await header.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ animations: 'disabled', path: info.outputPath('spectator.png') });
  });
}
