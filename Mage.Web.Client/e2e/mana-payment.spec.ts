import { expect, test, type Page } from '@playwright/test';
import type { GameSession } from '../src/core/game/gameSession';

test.skip(process.env.MAGE_WEB_E2E_PREVIEW === '1' && process.env.PLAYMAT_PAYMENT_FIXTURE_BUILT !== '1', 'isolated fixture requires its explicit test build');
test.use({ hasTouch: true, isMobile: true });

test.beforeEach(({ baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) {
    throw new Error('Mana/payment presentation fixtures must use an isolated loopback server');
  }
});

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`public target receipts preserve manual controls at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/e2e/fixtures/mana-payment.html');
    await expect(page.getByRole('button', { name: 'Auto-pay', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const { session } = (window as unknown as { paymentFixture: { session: GameSession } }).paymentFixture;
      session.store.setState((state) => {
        if (!state.view?.stack?.spell) throw new Error('Synthetic stack fixture not ready');
        return { view: { ...state.view, stack: { ...state.view.stack, spell: { ...state.view.stack.spell, targets: ['them', 'opponentForest'] } } } };
      });
    });
    const receipt = page.getByRole('complementary', { name: 'Recent action' });
    await expect(receipt.getByText('Targets announced', { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Stack targets' })).toHaveCount(0);
    await expect(page.locator('[data-stack-source="spell"][data-stack-target="them"]')).toHaveCount(1);
    await expect(page.locator('[data-stack-source="spell"][data-stack-target="opponentForest"]')).toHaveCount(1);
    expect(await receipt.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    await page.locator('[data-object-id="forest"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls)).toEqual(['forest']);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls)).toEqual(['forest', 'cancel']);
  });
}

async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: test.info().outputPath(name) });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 844, height: 390 }]) {
  test(`mana payment remains usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/e2e/fixtures/mana-payment.html?lang=es');
    const corner = page.getByRole('region', { name: 'Your decision' });
    const pay = corner.getByRole('button', { name: 'Autopagar', exact: true });
    await expect(pay).toBeEnabled();
    await expect(corner.getByText('Coste pendiente')).toBeVisible();
    await expect(corner.getByRole('navigation')).toHaveCount(0);
    const cancel = corner.getByRole('button', { name: 'Cancelar', exact: true });
    expect(await cancel.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
    for (const button of [pay, cancel, page.getByRole('button', { name: /emote|gestos/i })]) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(43);
      expect(box!.height).toBeGreaterThanOrEqual(43);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    }
    const life = await page.locator('[data-object-id="me"]').boundingBox();
    const emote = await page.getByRole('button', { name: /emote|gestos/i }).boundingBox();
    expect(emote!.y + emote!.height).toBeLessThan(life!.y);
    await screenshot(page, `payment-${viewport.width}x${viewport.height}.png`);
    await pay.dblclick();
    await expect(corner.getByRole('button', { name: 'Autopagar', exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls)).toEqual(['forest', 'island']);
  });
}

test('manual taps update the remaining cost', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/mana-payment.html');
  await page.locator('[data-object-id="forest"]').click();
  await expect(page.getByRole('region', { name: 'Your decision' }).getByRole('img', { name: 'G', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls)).toEqual(['forest']);
});

test('cancel stays usable while the first automatic tap is awaiting confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/mana-payment.html?holdTap');
  const calls = () => page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls);
  await page.getByRole('button', { name: 'Auto-pay', exact: true }).click();
  await expect.poll(calls).toEqual(['forest']);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await calls()).toEqual(['forest']);
  await page.evaluate(() => (window as unknown as { paymentFixture: { releaseTap(): void } }).paymentFixture.releaseTap());
  await expect.poll(calls).toEqual(['forest', 'cancel']);
});

test('insufficient sources explain the blocked auto-pay and allow cancellation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/mana-payment.html?scenario=insufficient');
  await expect(page.getByRole('button', { name: 'Auto-pay', exact: true })).toBeDisabled();
  await expect(page.getByText(/Not enough known mana sources/)).toBeVisible();
  await screenshot(page, 'insufficient-mana.png');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auto-pay', exact: true })).toHaveCount(0);
});

test('desktop keeps the phase ladder and emote beside the seat', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/e2e/fixtures/mana-payment.html?scenario=priority');
  await expect(page.getByRole('region', { name: 'Your decision' }).getByRole('navigation')).toBeVisible();
  await expect(page.getByRole('button', { name: /emote|gestos/i })).toHaveCount(1);
  await screenshot(page, 'desktop-priority.png');
});

test('rotation and simulated iOS safe areas preserve the active payment', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/mana-payment.html');
  const pay = page.getByRole('button', { name: 'Auto-pay', exact: true });
  await expect(pay).toBeEnabled();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('[data-layout]').evaluate((stage) => { stage.parentElement!.style.inset = '0px 47px 21px'; });
  await expect(page.locator('[data-layout="wide"]')).toBeVisible();
  await expect(pay).toBeEnabled();
  // The ResizeObserver applies the new stage scale on the next frame after the inset changes.
  await expect.poll(async () => {
    const box = await page.getByRole('region', { name: 'Your decision' }).boundingBox();
    return !!box && box.x >= 47 && box.x + box.width <= 797 && box.y + box.height <= 369;
  }).toBe(true);
  const corner = await page.getByRole('region', { name: 'Your decision' }).boundingBox();
  expect(corner!.x).toBeGreaterThanOrEqual(47);
  expect(corner!.x + corner!.width).toBeLessThanOrEqual(844 - 47);
  expect(corner!.y + corner!.height).toBeLessThanOrEqual(390 - 21);
  expect(await page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls)).toEqual([]);
  await screenshot(page, 'landscape-safe-areas.png');
});

test('floating mana has a readable touch target inside the mobile payment panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/mana-payment.html?pool');
  const pool = page.getByRole('region', { name: 'Your decision' }).getByRole('button', { name: 'Pay with G mana, 1 in your pool' });
  await expect(pool).toBeVisible();
  const box = await pool.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(43);
  expect(box!.width).toBeGreaterThanOrEqual(43);
  expect(await page.locator('[data-object-id="forest"]').evaluate((card) => {
    const rect = card.getBoundingClientRect();
    return card.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await screenshot(page, 'manual-pool.png');
  await pool.click();
  await expect(pool).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls)).toEqual(['GREEN']);
});

for (const [language, label] of [['en', 'Decision idle:'], ['es', 'Inactividad:']] as const) {
  test(`own inactivity warning is separate from the match clock and leaves mobile controls usable (${language})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e2e/fixtures/mana-payment.html?lang=${language}`);
    await page.evaluate(() => {
      const { session } = (window as unknown as { paymentFixture: { session: GameSession } }).paymentFixture;
      session.store.setState((state) => ({ view: { ...state.view, priorityTime: 0, responseIdle: {
        status: 'running', sampledAtEpochMs: 1_000_000, deadlineEpochMs: 1_060_000, remainingMillis: 60_000, timeoutSeconds: 60,
      } } }));
    });
    await expect(page.getByRole('timer')).toContainText(label);
    // A 1970 server epoch deliberately differs from the browser's clock: a fresh sample still has a minute.
    await expect(page.getByRole('timer')).toHaveText(new RegExp(`${label} (1:00|0:5[0-9])`));
    await expect(page.getByRole('timer')).toHaveAttribute('aria-live', 'off');
    await page.locator('[data-object-id="forest"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { paymentFixture: { calls: string[] } }).paymentFixture.calls)).toEqual(['forest']);
  });
}
