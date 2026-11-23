import { expect, test } from '@playwright/test';

test.skip(process.env.MAGE_WEB_E2E_PREVIEW === '1', 'the isolated synthetic fixture runs on the Vite dev server');
test.beforeEach(({ baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('This fixture runs on loopback only');
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  test.describe(`land animation at ${viewport.width}px`, () => {
    const touch = viewport.width < 1000;
    test.use({ viewport, isMobile: touch, hasTouch: touch });
    test('compares two identical lands and selects the exact legal target', async ({ page }, info) => {
      await page.goto('/e2e/fixtures/land-animation.html');
      const picker = page.getByRole('dialog', { name: 'Elige una tierra para animar' });
      const recent = picker.getByRole('button', { description: /necesita prisa para atacar/ });
      const established = picker.getByRole('button', { description: /Sin indicios de mareo/ });
      await expect(recent).toBeEnabled();
      await expect(established).toBeEnabled();
      await expect(recent.locator('img')).toHaveAttribute('src', '/career-art/land/vista-forest.webp');
      await expect(established.locator('img')).toHaveAttribute('src', '/career-art/land/vista-forest.webp');
      const caption = recent.locator('[id^=land-choice-]');
      const size = await caption.evaluate(node => {
        const stage = node.closest('[data-layout]')!;
        return parseFloat(getComputedStyle(node).fontSize) * new DOMMatrix(getComputedStyle(stage).transform).a;
      });
      expect(size).toBeGreaterThanOrEqual(touch ? 14 : 12);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ animations: 'disabled', path: info.outputPath('selector.png') });
      await picker.getByRole('button', { name: 'Ver el campo de batalla' }).click();
      const boardCard = page.locator('[data-object-id=second]');
      await expect(boardCard).toHaveAccessibleDescription(/necesita prisa para atacar/);
      await page.screenshot({ animations: 'disabled', path: info.outputPath('tablero.png') });
      if (!touch) {
        await boardCard.click({ button: 'right' });
        const detail = page.getByRole('dialog', { name: 'Bosque' });
        await expect(detail.getByText(/el control reciente no impide girarla para obtener maná/)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(detail).not.toBeVisible();
      }
      await page.getByRole('button', { name: 'Volver a la elección' }).click();
      if (touch) await recent.tap();
      else {
        await established.focus();
        await page.keyboard.press('ArrowRight');
        await expect(recent).toBeFocused();
        await page.keyboard.press('Enter');
      }
      await expect.poll(() => page.evaluate(() => (window as unknown as { landAnimationPicks: string[] }).landAnimationPicks)).toEqual(['second']);
    });
  });
}
