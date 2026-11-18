import { expect, test, type Page } from '@playwright/test';

test.skip(process.env.MAGE_WEB_E2E_PREVIEW === '1' && process.env.PLAYMAT_PAYMENT_FIXTURE_BUILT !== '1', 'isolated fixture requires its explicit test build');

test.beforeEach(({ baseURL }) => {
  if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Chat/social fixtures must remain on an isolated loopback server');
});

async function shot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: test.info().outputPath(name) });
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
    test('chat preserves Spanish, literal text and the MCP seat alias without executing markup', async ({ page }) => {
      await page.goto('/e2e/fixtures/chat-social.html?surface=chat', { waitUntil: 'domcontentloaded' });
      const lines = page.getByRole('complementary', { name: 'Chat de partida' }).getByRole('list');
      await expect(lines).toContainText('Ahora sí, revancha sin regalar turnos 😈 Suerte, Felipe.');
      await expect(lines).toContainText('La nutria ya llegó a la oficina. Hoy sí 😄');
      await expect(lines).toContainText('El único objetivo también deja sin resolver Learn.');
      await expect(lines).toContainText('3/3 con 2 daños. Ese +1/+1 extra sí importa.');
      await expect(lines).toContainText('Unicode directo: ÁÉÍÓÚ ü ñ 🦝');
      await expect(lines).toContainText('Literal: &iacute; [abc] {G}');
      await expect(lines).toContainText('<img src=x onerror=window.hostileExecuted=true>');
      await expect(lines).toContainText('Rakún:');
      await expect(page.locator('[data-object-id="rival"]')).toHaveAttribute('aria-label', /Rakún/);
      await expect(page.locator('body')).not.toContainText('mcp_1234567890');
      await expect(lines.locator('[onerror], img[src="x"], script')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { hostileExecuted: boolean }).hostileExecuted)).toBe(false);
      await lines.evaluate((list) => { list.scrollTop = 0; });
      await shot(page, `chat-${viewport.width}.png`);
      await lines.evaluate((list) => { list.scrollTop = list.scrollHeight; });
      await shot(page, `literal-chat-${viewport.width}.png`);
    });

    test('human lobby lists, counts, directory search and profiles remain usable', async ({ page }) => {
      await page.goto('/e2e/fixtures/chat-social.html?surface=players', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Lobby: 2 online' })).toBeVisible();
      const list = page.getByRole('list', { name: 'Players online' });
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await expect(list).toContainText('Felipe');
      await expect(list).toContainText('Bob');
      await expect(page.locator('body')).not.toContainText('mcp_1234567890');
      await shot(page, `players-${viewport.width}.png`);
      await page.getByRole('tab', { name: 'Find' }).click();
      const directory = page.getByRole('list', { name: 'Registered players' });
      await expect(directory.getByRole('listitem')).toHaveCount(2);
      await page.getByRole('searchbox', { name: 'Find a player' }).fill('Bob');
      await expect(directory.getByRole('listitem')).toHaveCount(1);
      await expect(directory).toContainText('Bob');
      await shot(page, `directory-${viewport.width}.png`);
      await directory.getByTitle("Bob's profile").click();
      await expect(page.getByRole('dialog', { name: 'Bob' })).toBeVisible();
      await shot(page, `profile-${viewport.width}.png`);
    });
  });
}
