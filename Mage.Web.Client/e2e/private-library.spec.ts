import { expect, test, type Page } from '@playwright/test';
import type { GameSession } from '../src/core/game/gameSession';

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'private build only');
test.skip(process.env.MAGE_WEB_E2E_PREVIEW === '1' && process.env.PLAYMAT_PRIVATE_FIXTURE_BUILT !== '1', 'explicit isolated fixture build required');
test.beforeEach(({ baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw Error('Private presentation fixtures require a loopback server');
});
async function shot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: test.info().outputPath(name), fullPage: true });
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls);
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width < 1000, isMobile: viewport.width < 1000 });
    test('background login, delayed library, reusable MCP shelf and an explicit legacy move', async ({ page }) => {
      const starters: string[] = [];
      page.on('request', (request) => { if (request.url().includes('/starter-decks/')) starters.push(request.url()); });
      let releaseIdentity!: () => void, releaseLibrary!: () => void;
      const identityGate = new Promise<void>((resolve) => { releaseIdentity = resolve; });
      const libraryGate = new Promise<void>((resolve) => { releaseLibrary = resolve; });
      const decks = new Map([
        ['mine', { id: 'mine', name: 'Gruul propio', format: 'Pioneer', library: 'personal', revision: 1, updatedAt: 10, cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] }],
        ['rival', { id: 'rival', name: 'Rakún Burn', format: 'Pioneer', library: 'agent', revision: 1, updatedAt: 20, cards: [{ cardName: 'Mountain', amount: 60 }], sideboard: [] }],
      ]);
      await page.addInitScript(() => localStorage.setItem('playmat.login', JSON.stringify({ userName: 'OldXmageName', serverUrl: 'wss://old.example/ws', passwordless: true })));
      await page.route('**/api/playtesting/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/me')) { await identityGate; return route.fulfill({ json: { engineName: 'Alice', agent: false } }); }
        if (url.pathname === '/api/playtesting/decks') {
          await libraryGate;
          return route.fulfill({ json: { decks: [...decks.values()].map(({ id, revision, updatedAt, library }) => ({ id, revision, updatedAt, library })) } });
        }
        const id = url.pathname.split('/')[4];
        const saved = decks.get(id);
        if (!saved) return route.fulfill({ status: 404, json: {} });
        if (route.request().method() === 'PUT') saved.revision += 1;
        if (url.pathname.endsWith('/library')) {
          saved.library = route.request().postDataJSON().library;
          saved.updatedAt += 1;
        }
        return route.fulfill({ json: { ...saved, data: saved } });
      });
      await page.goto('/e2e/fixtures/private-library.html');
      await expect(page.getByRole('heading', { name: 'Conectando tu mesa…' })).toBeVisible();
      await expect(page.locator('input, form')).toHaveCount(0);
      await shot(page, `connecting-${viewport.width}.png`);
      releaseIdentity();
      await expect(page.getByText('Cargando tu biblioteca…')).toBeVisible();
      await expect(page.getByText('Gruul propio', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Rakún Burn', { exact: true })).toHaveCount(0);
      await shot(page, `loading-${viewport.width}.png`);
      releaseLibrary();
      await expect(page.getByRole('heading', { name: 'Gruul propio' })).toBeVisible();
      for (const button of await page.locator('section > header').first().getByRole('button').all()) {
        const bounds = await button.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      }
      await expect(page.getByText('Rakún Burn', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { privateLibraryFixture: { authCalls: { name: string; passwordProvided: boolean }[] } }).privateLibraryFixture.authCalls)).toEqual([{ name: 'Alice', passwordProvided: false }]);
      expect(starters).toEqual([]);
      await shot(page, `personal-library-${viewport.width}.png`);
      await page.getByRole('button', { name: 'Rival IA · MCP', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Rakún Burn' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rival IA · MCP', exact: true }).locator('span')).toHaveCSS('color', 'rgb(29, 20, 6)');
      await expect(page.getByText('Gruul propio', { exact: true })).toHaveCount(0);
      await shot(page, `mcp-library-${viewport.width}.png`);
      await page.getByRole('button', { name: 'Mis mazos', exact: true }).click();
      await page.getByRole('button', { name: 'Mover a Rival IA · MCP', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Gruul propio' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Rival IA · MCP', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Gruul propio' })).toBeVisible();
      expect(decks.get('mine')!.cards).toEqual([{ cardName: 'Forest', amount: 60 }]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

    test('old automatic settings cannot spend mana before AUTO PAY, and a new payment waits again', async ({ page }) => {
      await page.goto('/e2e/fixtures/mana-payment.html?legacyAutoPay&lang=es');
      const pay = page.getByRole('button', { name: 'AUTO PAY', exact: true });
      await expect(pay).toBeEnabled();
      await page.waitForTimeout(800);
      expect(await calls(page)).toEqual([]);
      const box = await pay.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(43);
      expect(box!.width).toBeGreaterThanOrEqual(43);
      await shot(page, `manual-mana-${viewport.width}.png`);
      await page.locator('[data-object-id="forest"]').click();
      await expect.poll(() => calls(page)).toEqual(['forest']);
      await expect(pay).toBeEnabled();
      await pay.dblclick();
      await expect.poll(() => calls(page)).toEqual(['forest', 'island']);
      await expect.poll(() => page.evaluate(() => (window as unknown as { paymentFixture: { session: GameSession } }).paymentFixture.session.getState().interaction.mode)).toBe('priority');
      await expect(pay).toHaveCount(0);
      await page.evaluate(() => (window as unknown as { paymentFixture: { resetPayment(): void } }).paymentFixture.resetPayment());
      await expect(pay).toBeEnabled();
      await page.waitForTimeout(800);
      expect(await calls(page)).toEqual(['forest', 'island']);
      await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await expect.poll(() => calls(page)).toEqual(['forest', 'island', 'cancel']);
    });
  });
}

test('AUTO PAY turns the lands without animating their position or dimming', async ({ page }) => {
  await page.goto('/e2e/fixtures/mana-payment.html?motion');
  const lands = page.locator('[data-object-id="forest"], [data-object-id="island"]');
  await expect(lands).toHaveCount(2);
  await lands.evaluateAll((cards) => {
    for (const card of cards) {
      const record = () => card.setAttribute('data-payment-motion', 'running');
      card.addEventListener('transitionrun', (event) => {
        if (event instanceof TransitionEvent && ['transform', 'filter'].includes(event.propertyName)) record();
      });
      const animate = card.animate.bind(card);
      card.animate = (frames, options) => {
        record();
        return animate(frames, options);
      };
    }
  });
  await page.getByRole('button', { name: 'AUTO PAY', exact: true }).click();
  await expect.poll(() => lands.evaluateAll((cards) => cards.every((card) => {
    const transform = new DOMMatrixReadOnly(getComputedStyle(card).transform);
    return Math.abs(transform.a) < 0.001 && Math.abs(transform.b - 1) < 0.001;
  }))).toBe(true);
  await expect(page.locator('[data-payment-motion]')).toHaveCount(0);
});

test('insufficient private mana leaves AUTO PAY disabled and cancel available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/mana-payment.html?legacyAutoPay&scenario=insufficient&lang=es');
  await expect(page.getByRole('button', { name: 'AUTO PAY', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect(await calls(page)).toEqual(['cancel']);
});

test('an expired browser cookie returns to the product sign-in instead of offering an XMage identity', async ({ page }) => {
  await page.route('**/api/playtesting/me', (route) => route.fulfill({ status: 401, json: { error: 'Authentication required' } }));
  await page.route('**/login?next=*', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Cuenta Playmat</h1>' }));
  await page.goto('/e2e/fixtures/private-library.html');
  await expect(page).toHaveURL(/\/login\?next=%2Fdecks$/);
  await expect(page.getByRole('heading', { name: 'Cuenta Playmat' })).toBeVisible();
});
