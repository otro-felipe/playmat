import { expect, test, type Page } from '@playwright/test';
import { concede, decisionCluster, gameOver, importTestDeck, keepOpeningHand, playerName, requireServer, signIn } from './helpers/app';

/**
 * Hosting and joining a table between two players, each in their own browser: the host opens a table, the guest
 * joins it from Tables, the host starts it and both land in the game. Needs the local server
 * (MAGE_E2E_REQUIRE_SERVER=1).
 */

const tableRow = (page: Page, tableName: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: tableName }) });

test.describe('app: tables', () => {
  test.skip(!requireServer, 'needs the local server (MAGE_E2E_REQUIRE_SERVER=1)');
  test.use({ actionTimeout: 20_000 });

  test('host a table, a friend joins, the host starts it', async ({ browser }) => {
    test.setTimeout(240_000);
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const tableName = `Duel ${Date.now() % 100000}`;

    try {
      await signIn(host, playerName('host'), '/tables');
      await host.getByRole('button', { name: 'Host a table' }).click();
      const dialog = host.getByRole('dialog', { name: 'Host a table' });
      await dialog.getByLabel('Table name').fill(tableName);
      await dialog.getByLabel('Games to win').selectOption('1');
      await dialog.getByRole('button', { name: 'Host', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 20_000 });
      const mine = tableRow(host, tableName);
      await expect(mine).toBeVisible({ timeout: 20_000 });
      await expect(mine.getByRole('button', { name: 'Start' })).toBeDisabled();

      await signIn(guest, playerName('guest'), '/tables');
      const open = tableRow(guest, tableName);
      await expect(open).toBeVisible({ timeout: 20_000 });
      await open.getByRole('button', { name: 'Join' }).click();

      // both seats taken: the host starts the match
      await expect(mine.getByRole('button', { name: 'Start' })).toBeEnabled({ timeout: 20_000 });
      await mine.getByRole('button', { name: 'Start' }).click();
      await Promise.all([
        host.waitForURL(/\/game\//, { timeout: 60_000 }),
        guest.waitForURL(/\/game\//, { timeout: 60_000 }),
      ]);

      // whoever won the roll chooses; both keep their hands
      await Promise.all([keepOpeningHand(host), keepOpeningHand(guest)]);
      await expect(host.getByRole('list', { name: /^Your hand, \d+ cards$/ })).toBeVisible({ timeout: 30_000 });
      await expect(guest.getByRole('list', { name: /^Your hand, \d+ cards$/ })).toBeVisible({ timeout: 30_000 });

      // the player whose turn it is holds priority, so their concession ends the game at once
      // (the other player's would wait for the active player to act)
      const hostsTurn = /your turn/.test((await host.getByRole('navigation', { name: /^Turn \d+/ }).getAttribute('aria-label')) ?? '');
      const [loser, winner] = hostsTurn ? [host, guest] : [guest, host];
      await concede(loser);
      await expect(gameOver(loser).getByRole('heading', { name: 'Defeat' })).toBeVisible();
      await gameOver(winner).waitFor({ timeout: 30_000 });
      await expect(gameOver(winner).getByRole('heading', { name: 'Victory' })).toBeVisible();
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('[PM-AC-06] both seats sideboard in a Pioneer Bo3 and a 2–0 finishes without another game', async ({ browser }) => {
    test.setTimeout(240_000);
    const [hostContext, guestContext] = await Promise.all([browser.newContext(), browser.newContext()]);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const tableName = `Review ${Date.now() % 100000}`;

    try {
      await registerSideboardDeck(host, 'host');
      await registerSideboardDeck(guest, 'guest');
      await host.getByRole('button', { name: 'Host a table' }).click();
      const dialog = host.getByRole('dialog', { name: 'Host a table' });
      await dialog.getByLabel('Table name').fill(tableName);
      await dialog.getByLabel('Format').selectOption('Constructed - Pioneer');
      await dialog.getByLabel('Games to win').selectOption('2');
      await dialog.getByRole('button', { name: 'Host', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 20_000 });
      await tableRow(guest, tableName).getByRole('button', { name: 'Join' }).click();
      await tableRow(host, tableName).getByRole('button', { name: 'Start' }).click();
      await openGame(host, guest);
      const firstGame = host.url();
      const hostsTurn = /your turn/.test((await host.getByRole('navigation', { name: /^Turn \d+/ }).getAttribute('aria-label')) ?? '');
      const [loser, winner] = hostsTurn ? [host, guest] : [guest, host];
      await requestConcede(loser);
      await Promise.all([winner.waitForURL(/\/build\//), loser.waitForURL(/\/build\//)]);

      const sideboard = winner.getByRole('region', { name: 'Sideboard, 15 cards' });
      await expect(sideboard.getByRole('button', { name: 'Island' })).toHaveCount(15);
      const titleStrip = { position: { x: 22, y: 12 } };
      await sideboard.getByRole('button', { name: 'Island' }).first().click(titleStrip);
      const editedDeck = winner.getByRole('region', { name: 'Deck, 61 cards' });
      await expect(editedDeck.getByRole('button', { name: 'Island' })).toHaveCount(1);
      await editedDeck.getByRole('button', { name: 'Plains' }).first().click(titleStrip);
      await expect(sideboard.getByRole('button', { name: 'Plains' })).toBeVisible();
      await expect(loser.getByRole('region', { name: 'Sideboard, 15 cards' }).getByRole('button', { name: 'Plains' })).toHaveCount(0);
      await winner.getByRole('button', { name: 'Submit deck' }).click();
      await expect(winner.getByText('Deck submitted — waiting for the others')).toBeVisible();
      await loser.getByRole('button', { name: 'Submit deck' }).click();

      await openGame(host, guest);
      expect(host.url()).not.toBe(firstGame);
      await requestConcede(loser);
      const pass = decisionCluster(winner).getByRole('button', { name: /^(go to|pass$)/i });
      await Promise.race([pass.click({ timeout: 15_000 }), gameOver(winner).waitFor({ timeout: 15_000 })]);
      await expect(gameOver(winner).getByRole('heading', { name: 'Victory' })).toBeVisible();
      await expect(gameOver(loser).getByRole('heading', { name: 'Defeat' })).toBeVisible();
      await expect(winner).toHaveURL(/\/game\//);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});

async function registerSideboardDeck(page: Page, name: string) {
  await signIn(page, playerName(name), '/decks');
  await importTestDeck(page, 'Sideboard test deck', '60 Plains\n\nSideboard\n15 Island');
  await page.getByRole('link', { name: 'Tables', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Host a table' })).toBeEnabled();
}

async function openGame(host: Page, guest: Page) {
  await Promise.all([host.waitForURL(/\/game\//), guest.waitForURL(/\/game\//)]);
  await Promise.all([keepOpeningHand(host), keepOpeningHand(guest)]);
  await Promise.all([host, guest].map((page) =>
    expect(page.getByRole('navigation', { name: /^Turn \d+/ })).toBeVisible({ timeout: 30_000 })));
}

async function requestConcede(page: Page) {
  await page.getByRole('button', { name: 'Game menu' }).click();
  await page.getByRole('menuitem', { name: 'Concede' }).click();
  await page.getByRole('dialog', { name: /concede this game/i }).getByRole('button', { name: 'Concede' }).click();
}
