import { expect, test, type Locator, type Page } from '@playwright/test';
import { decisionCluster, importTestDeck, keepOpeningHand, playerName, requireServer, signIn, startAiGame } from './helpers/app';

/**
 * The match on a phone held upright, played by touch: the tall layout, a long press that opens a card's detail
 * instead of playing it, a tap that plays, and an independent stop on the phase strip. Needs the local server
 * (MAGE_E2E_REQUIRE_SERVER=1).
 */
test.describe('app: the match on a phone, by touch', () => {
  test.skip(!requireServer, 'needs the local server (MAGE_E2E_REQUIRE_SERVER=1)');
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  /** Holds a finger on the element for a while, through the DevTools protocol (Playwright only taps). */
  async function longPress(page: Page, target: Locator, ms = 700) {
    const box = await target.boundingBox();
    if (!box) throw new Error('nothing to press');
    const point = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 24) };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  test('[PM-AC-03] card inspection, play and phase stops fit on a phone', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, playerName('tablet'), '/decks');
    await importTestDeck(page, 'Touch test deck', '60 Plains');
    await page.goto('/');
    await startAiGame(page, 'Touch test deck');
    await keepOpeningHand(page);

    await expect(page.locator('[data-layout="tall"]')).toBeVisible();
    const hand = page.getByRole('list', { name: /^Your hand, \d+ cards$/ });
    const playable = hand.getByRole('listitem', { name: /, playable$/ });
    await expect(playable.first()).toBeVisible({ timeout: 60_000 });
    const count = await hand.getByRole('listitem').count();
    const name = ((await playable.first().getAttribute('aria-label')) ?? '').replace(/, playable$/, '');

    // held: the detail view opens and the card stays in hand
    await longPress(page, playable.first());
    const detail = page.getByRole('dialog', { name });
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Close' }).tap();
    await expect(detail).toBeHidden();
    await expect(hand.getByRole('listitem')).toHaveCount(count);

    // tapped: played (a land, or a spell that goes to the stack)
    await playable.first().tap();
    await expect(hand.getByRole('listitem')).toHaveCount(count - 1, { timeout: 20_000 });

    const corner = decisionCluster(page);
    const phases = corner.getByRole('navigation', { name: /^Turn \d+/ });
    const combat = phases.getByRole('button', { name: 'Combat', exact: true });
    await expect(combat).toBeVisible();
    const box = await combat.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await combat.tap();
    await expect(combat).toHaveAttribute('aria-pressed', 'true');

    // Sample both localized labels on the same live primary control, without changing the engine prompt.
    const primary = corner.getByRole('button', { name: /^(Go to |Pass$)/ });
    const [short, long] = await primary.evaluate((button) => {
      const label = button.querySelector('span')!;
      const saved = label.textContent;
      try {
        return ['Pasar', 'Ir a próximo turno'].map((text) => {
          label.textContent = text;
          const { width, height } = button.getBoundingClientRect();
          return { width, height, fits: label.scrollWidth <= label.clientWidth + 1 };
        });
      } finally {
        label.textContent = saved;
      }
    });
    expect(long).toEqual(short);
    expect(long.fits).toBe(true);
    expect(long.height).toBeGreaterThanOrEqual(44);

    // A space typed into chat must not answer the current priority prompt.
    await page.getByRole('button', { name: 'Chat', exact: true }).tap();
    const chat = page.getByRole('textbox', { name: 'Chat message' });
    const step = await phases.locator('[aria-current="step"]').first().getAttribute('aria-label');
    await chat.fill('Testing');
    await chat.press('Space');
    await chat.press('a');
    await expect(chat).toHaveValue('Testing a');
    await expect(phases.locator('[aria-current="step"]').first()).toHaveAttribute('aria-label', step!);
  });
});
