import { expect, test } from '@playwright/test';
import { spectatorSnapshot } from './fixtures/spectatorSnapshot';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private playtesting routes');

const source = { name: 'Formidable Speaker', kind: 'card' };
const effect = 'When this creature enters, you may discard a card. If you do, search your library for a creature card, reveal it, put it into your hand, then shuffle.';

for (const width of [1440, 390]) {
  test(`[CUP-AC-006] spectator effects stay legible in resolution order at ${width}px`, async ({ page, baseURL }) => {
    expect(['127.0.0.1', 'localhost']).toContain(new URL(baseURL!).hostname);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    await page.addInitScript(() => localStorage.setItem('playmat.settings', JSON.stringify({ locale: 'en', animations: false })));
    await page.route('**/api/playtesting/tournaments/**', route => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 30000\n\n' });
      if (!pathname.endsWith('/watch')) return route.fulfill({ json: { viewer: null } });
      return route.fulfill({ json: { ...spectatorSnapshot, visibility: 'public-board', hands: {}, view: {
        ...spectatorSnapshot.view,
        stack: {
          first: { id: 'first', isAbility: true, stackAbility: { kind: 'triggered', source, effect } },
          second: { id: 'second', isAbility: true, stackAbility: { kind: 'triggered', source } },
          third: { id: 'third', name: 'Reckless Rage' },
        },
      } } });
    });
    await page.goto('/tournaments/sample/pairings/example/watch');
    const list = page.getByRole('region', { name: 'Stack, 3 objects' });
    const first = list.getByRole('listitem').nth(0);
    const text = first.getByText(effect, { exact: true });
    const fallback = list.getByRole('listitem').nth(1).getByText('Effect text unavailable', { exact: true });
    await expect(first.getByText('Resolving next')).toBeVisible();
    await expect(text).toBeInViewport();
    await expect(fallback).toBeInViewport();
    const [effectBox, fallbackBox] = await Promise.all([text.boundingBox(), fallback.boundingBox()]);
    expect(effectBox!.y + effectBox!.height).toBeLessThan(fallbackBox!.y);
    const viewportFontSize = await text.evaluate(element => {
      const transform = getComputedStyle(element.closest('[data-layout]')!).transform;
      return parseFloat(getComputedStyle(element).fontSize) * new DOMMatrixReadOnly(transform).a;
    });
    expect(Math.round(viewportFontSize * 100) / 100).toBeGreaterThanOrEqual(13);
  });
}
