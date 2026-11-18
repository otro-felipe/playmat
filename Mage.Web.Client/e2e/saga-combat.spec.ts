import { expect, test, type Locator, type Page } from '@playwright/test';

test.skip(process.env.MAGE_WEB_E2E_PREVIEW === '1', 'component fixture uses Vite');
async function shot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: test.info().outputPath(name) });
}
async function separated(panel: Locator, ladder: Locator) {
  await expect.poll(async () => {
    const p = await panel.boundingBox(); const l = await ladder.boundingBox();
    return !!p && !!l && p.y + p.height < l.y;
  }).toBe(true);
}
for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width < 1000, isMobile: viewport.width < 1000 });
    test('shows chapters 0, 1 and 2 and keeps attack estimates clear of the turn controls', async ({ page }) => {
      await page.goto('/e2e/fixtures/saga-combat.html', { waitUntil: 'domcontentloaded' });
      const saga = page.locator('[data-object-id="saga"]');
      const chapter = saga.locator('[data-saga-chapter]');
      await expect(chapter).toHaveText('Cap.1');
      const fontSize = await chapter.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
      const scale = await page.locator('[data-layout]').evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a);
      expect(fontSize * scale).toBeGreaterThanOrEqual(12);
      const corner = page.getByRole('region', { name: 'Your decision' });
      const panel = corner.locator('[data-combat-preview]');
      const phases = corner.getByRole('navigation');
      await expect(panel).toContainText('Rival');
      await separated(panel, phases);
      const box = await corner.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      await phases.getByRole('button', { name: 'Combate', exact: true }).click();
      await expect(phases.getByRole('button', { name: 'Combate', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await shot(page, `attack-saga-${viewport.width}.png`);
      for (const count of [2, 0]) {
        await page.evaluate((value) => (window as unknown as { sagaCombatFixture: { setLore(count: number): void } }).sagaCombatFixture.setLore(value), count);
        await expect(chapter).toHaveText(`Cap.${count}`);
        await expect(saga).toHaveAttribute('aria-label', new RegExp(`Saga: ${count}`));
      }
    });

    test('expanded blocking details and a tapped Saga preserve visible, clickable phases and confirmation', async ({ page }) => {
      await page.goto('/e2e/fixtures/saga-combat.html?mode=block&crowded&tapped&chapter=2', { waitUntil: 'domcontentloaded' });
      const chapter = page.locator('[data-object-id="saga"] [data-saga-chapter]');
      await expect(chapter).toHaveText('Cap.2');
      const corner = page.getByRole('region', { name: 'Your decision' });
      const panel = corner.locator('[data-combat-preview]');
      const phases = corner.getByRole('navigation');
      const details = panel.locator('details');
      await panel.locator('summary').click();
      await expect(details).toHaveAttribute('open', '');
      await separated(panel, phases);
      const box = await corner.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      await shot(page, `block-expanded-saga-${viewport.width}.png`);
      await panel.locator('summary').focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => (window as unknown as { sagaCombatFixture: { calls: boolean[] } }).sagaCombatFixture.calls)).toEqual([]);
      await shot(page, `block-saga-${viewport.width}.png`);
      const confirm = corner.getByRole('button', { name: /block/i });
      await expect(confirm).toBeVisible();
      await confirm.click();
      expect(await page.evaluate(() => (window as unknown as { sagaCombatFixture: { calls: boolean[] } }).sagaCombatFixture.calls)).toEqual([true]);
    });
  });
}
