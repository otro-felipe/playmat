import { expect, test } from '@playwright/test';
import type { GameSession } from '../src/core/game/gameSession';

test.skip(process.env.MAGE_WEB_E2E_PREVIEW === '1' && process.env.PLAYMAT_PAYMENT_FIXTURE_BUILT !== '1', 'isolated fixture requires its explicit test build');

test.beforeEach(({ baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Stack UI fixtures must remain on an isolated loopback server');
});

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width < 1000, isMobile: viewport.width < 1000 });
    test('[READ-AC-004] Burst Lightning keeps its arrow to Doge below other spells, without a target panel', async ({ page }) => {
      await page.goto('/e2e/fixtures/mana-payment.html?scenario=priority');
      await page.evaluate(() => {
        const { session } = (window as unknown as { paymentFixture: { session: GameSession } }).paymentFixture;
        session.store.setState((state) => ({ view: {
          ...state.view,
          players: state.view!.players!.map((player) => player.playerId === 'them' ? { ...player, name: 'Doge', battlefield: { bear: { id: 'bear', name: 'Runeclaw Bear', cardTypes: ['CREATURE'], power: '2', toughness: '2' } } } : player),
          stack: {
            fork: { id: 'fork', name: 'Electrolyze', cardTypes: ['INSTANT'], targets: ['them', 'bear'], rules: ['Electrolyze deals 2 damage divided as you choose among one or two targets.'] },
            burst: { id: 'burst', name: 'Burst Lightning', cardTypes: ['INSTANT'], targets: ['them'], rules: ['Burst Lightning deals 2 damage to any target.'] },
            counter: { id: 'counter', name: 'Counterspell', cardTypes: ['INSTANT'], targets: ['burst'], rules: ['Counter target spell.'] },
          },
        } }));
      });
      const arrows = page.locator('g[data-stack-source]');
      await expect(arrows).toHaveCount(4);
      await expect(page.getByRole('list', { name: 'Stack targets' })).toHaveCount(0);
      await expect(page.getByText(/^Targets:/)).toHaveCount(0);
      const burst = page.locator('[data-stack-source="burst"][data-stack-target="them"]');
      const top = page.locator('[data-stack-source="fork"][data-stack-target="them"]');
      await expect(burst).toHaveAttribute('data-emphasis', 'waiting');
      const strokes = await Promise.all([burst, top].map((group) => group.locator('path').last().evaluate((path) => ({ dash: getComputedStyle(path).strokeDasharray, width: getComputedStyle(path).strokeWidth, d: path.getAttribute('d') }))));
      expect(strokes[0].dash).not.toBe('none');
      expect(strokes[1].dash).toBe('none');
      expect(strokes[0].d).not.toBe(strokes[1].d);
      expect(parseFloat(strokes[1].width)).toBeGreaterThan(parseFloat(strokes[0].width));
      const item = page.getByRole('listitem', { name: 'Burst Lightning, targets: Doge' });
      await item.focus();
      await expect(burst).toHaveAttribute('data-emphasis', 'focused');
      await expect(arrows).toHaveCount(4);
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.screenshot({ path: test.info().outputPath(`stack-targets-${viewport.width}x${viewport.height}.png`) });
      await page.getByRole('button', { name: 'Resolve', exact: true }).click();
      await expect(arrows).toHaveCount(0);
    });
  });
}
