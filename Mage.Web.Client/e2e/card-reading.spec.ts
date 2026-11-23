import { expect, test, type Page } from '@playwright/test';
import type { GameSession } from '../src/core/game/gameSession';

const text = 'Each opponent can’t draw more than one card each turn.';
const secret = 'A rule on the concealed face.';

test.skip(process.env.MAGE_WEB_E2E_PREVIEW === '1' && process.env.PLAYMAT_PAYMENT_FIXTURE_BUILT !== '1', 'needs the local match fixture');

async function match(page: Page) {
  // A Japanese printing with no English text baked into its pixels.
  const printing = '/test-japanese-print.svg';
  await page.route('**/cards/collection', (route) => route.fulfill({
    json: { data: [{ set: 'war', collector_number: '61', image_uris: { normal: printing, large: printing } }] },
  }));
  await page.route('**/test-japanese-print.svg', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 63 88"><rect width="63" height="88" fill="#293447"/><text x="5" y="18" fill="white" font-size="7">ナーセット</text></svg>',
  }));
  await page.goto('/e2e/fixtures/mana-payment.html?scenario=priority');
  await page.evaluate(({ text, secret }) => {
    const { session } = (window as unknown as { paymentFixture: { session: GameSession } }).paymentFixture;
    session.store.setState((state) => ({ view: { ...state.view, stack: {}, players: state.view!.players!.map(
      (player) => player.playerId === 'them' ? { ...player, battlefield: {
        narset: { id: 'narset', name: 'Narset, Parter of Veils', cardTypes: ['PLANESWALKER'],
          expansionSetCode: 'WAR', cardNumber: '61', loyalty: '5', rules: [text] },
        concealed: { id: 'concealed', name: 'Face-down card', faceDown: true, cardTypes: ['CREATURE'], rules: [secret] },
      } } : player) } }));
  }, { text, secret });
  await expect(page.locator('[data-object-id="narset"] [data-loaded] img')).toHaveAttribute('src', printing);
}

test('hover reads rules independently of printing, and a face-down card keeps its rules hidden', async ({ page }) => {
  await match(page);
  await page.locator('[data-object-id="narset"]').hover();
  await expect(page.getByText(text, { exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('hover-rules.png') });
  await page.locator('[data-object-id="concealed"]').hover();
  await page.locator('[data-object-id="concealed"]').click({ button: 'right' });
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
});

test('the inspected face supplies its own rules when a visible double-faced card turns over', async ({ page }) => {
  await match(page);
  await page.evaluate(() => {
    const { session } = (window as unknown as { paymentFixture: { session: GameSession } }).paymentFixture;
    session.store.setState((state) => ({ view: { ...state.view, myHand: { day: {
      id: 'day', name: 'Day face', cardTypes: ['CREATURE'], rules: ['Flying'], transformable: true,
      secondCardFace: { name: 'Night face', cardTypes: ['CREATURE'], rules: ['Trample'] },
    } } } }));
  });
  await page.locator('[data-object-id="day"]').click({ button: 'right' });
  const dialog = page.getByRole('dialog');
  const rules = dialog.getByRole('list').filter({ has: page.locator('li', { hasText: 'Keyword' }) });
  await expect(rules).toContainText('Flying');
  await expect(rules).not.toContainText('Trample');
  await dialog.getByRole('button', { name: 'Show the back face' }).click();
  await expect(rules).toContainText('Trample');
  await expect(rules).not.toContainText('Flying');
});

test.describe('touch inspection', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('long press on the battlefield opens rules at reading size before table state', async ({ page }) => {
    await match(page);
    const card = page.locator('[data-object-id="narset"]');
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    const dialog = page.getByRole('dialog', { name: 'Narset, Parter of Veils' });
    await expect(dialog).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    const rule = dialog.getByText(text, { exact: true });
    await expect(rule).toBeInViewport();
    const fontSize = await rule.evaluate((el) => {
      const stage = el.closest<HTMLElement>('[data-layout]')!;
      return parseFloat(getComputedStyle(el).fontSize) * stage.getBoundingClientRect().width / stage.offsetWidth;
    });
    expect(fontSize).toBeGreaterThanOrEqual(15);
    const state = dialog.getByRole('region', { name: 'On the table' });
    expect((await rule.boundingBox())!.y).toBeLessThan((await state.boundingBox())!.y);
    await page.screenshot({ path: test.info().outputPath('touch-rules.png') });
    await dialog.getByRole('button', { name: 'Close' }).tap();
    await expect(dialog).toBeHidden();
  });
});
