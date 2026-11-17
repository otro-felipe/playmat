import { expect, test } from '@playwright/test';

// Vite serves this isolated component fixture; it is not part of the production build.
test.skip(process.env.MAGE_WEB_E2E_PREVIEW === '1', 'component fixture needs the Vite development server');
test.use({ hasTouch: true });

for (const [label, action] of [
  ['Accept', 'ADD_PERMISSION_TO_ROLLBACK_TURN'], ['Deny', 'DENY_PERMISSION_TO_ROLLBACK_TURN'],
]) {
  test(`rollback blocks accidental dismissal until explicit ${label}`, async ({ page }) => {
    await page.goto('/e2e/fixtures/request-dialog.html');
    await page.getByRole('button', { name: 'Request rollback', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Rollback request' });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Close' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    await page.mouse.click(2, 2, { button: 'right' });
    await page.touchscreen.tap(2, 2);
    for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      await expect(modal.locator(':focus')).toHaveCount(1);
    }
    await expect(modal).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Hand request' })).toHaveCount(0);
    await expect(page.locator('output')).toHaveText('[]');
    await page.screenshot({ path: test.info().outputPath(`rollback-before-${label.toLowerCase()}.png`) });
    await modal.getByRole('button', { name: label, exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('output')).toHaveText(JSON.stringify([[action, 'fixture-game', 'fixture-vote']]));
    await expect(page.getByRole('dialog', { name: 'Hand request' })).toBeVisible();
    // The next, unrelated request can still be closed normally.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
