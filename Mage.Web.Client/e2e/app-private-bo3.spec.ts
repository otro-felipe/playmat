import { expect, test } from '@playwright/test';
import { importTestDeck, gameOver } from './helpers/app';
import { finishBestOfThree, sideboardDeck } from './helpers/bo3';
import { qaAccount, setPrivateInput, signInPrivate, tableRow } from './helpers/private';

const baseURL = process.env.PLAYMAT_PRIVATE_BASE_URL;

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test.describe('Private playtesting browser acceptance', () => {
  test.skip(!baseURL, 'Set PLAYMAT_PRIVATE_BASE_URL to opt in using provisioned QA accounts.');
  test.describe.configure({ retries: 0 });

  test('[PM-AC-04, PM-AC-06] a provisioned friend takes the invited seat and plays a Pioneer Bo3', async ({ browser }) => {
    test.setTimeout(240_000);
    // Playwright also takes an accessibility snapshot on failure independently of its trace setting.
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
    const hostAccount = qaAccount('A');
    const guestAccount = qaAccount('B');
    if (hostAccount.username.toLowerCase() === guestAccount.username.toLowerCase()) {
      throw new Error('Provide two different provisioned QA accounts.');
    }
    const origin = new URL(baseURL!).origin;
    const options = { baseURL: origin, locale: 'en-US', serviceWorkers: 'block' as const };
    const hostContext = await browser.newContext(options);
    const guestContext = await browser.newContext(options);
    hostContext.setDefaultTimeout(20_000);
    guestContext.setDefaultTimeout(20_000);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const tableName = `Browser QA ${Date.now()}`;
    const deckName = `QA Pioneer ${Date.now()}`;
    const hostTable = tableRow(host, tableName);
    try {
      await test.step('Both provisioned accounts sign in and register legal test decks', async () => {
        await signInPrivate(host, hostAccount);
        await importTestDeck(host, deckName, sideboardDeck);
        await signInPrivate(guest, guestAccount);
        await importTestDeck(guest, deckName, sideboardDeck);
      });

      await test.step('The host copies the invitation and the invited account occupies the second seat', async () => {
        await host.getByRole('link', { name: 'Tables', exact: true }).click();
        await host.getByRole('button', { name: 'Host a table' }).click();
        const dialog = host.getByRole('dialog', { name: 'Host a table' });
        await dialog.getByLabel('Table name').fill(tableName);
        await dialog.getByLabel('Format').selectOption('Constructed - Pioneer');
        await dialog.getByLabel('Games to win').selectOption('2');
        await setPrivateInput(dialog.getByLabel('Invited player'), guestAccount.username);
        await dialog.getByRole('button', { name: 'Host', exact: true }).click();
        await expect(dialog).toBeHidden({ timeout: 25_000 });
        await expect(hostTable.getByRole('button', { name: 'Start' })).toBeDisabled();
        await hostContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
        await hostTable.getByRole('button', { name: 'Invite', exact: true }).click();
        await expect(host.getByText('Invite link copied', { exact: true })).toBeVisible();
        const invite = await host.evaluate(() => navigator.clipboard.readText());
        if (!URL.canParse(invite)) throw new Error('The invite button did not copy a table URL.');
        const target = new URL(invite);
        if (target.origin !== origin || !/^\/join\/[\da-f-]+$/i.test(target.pathname) || target.search || target.hash) {
          throw new Error('The invite button did not copy a private table link on this origin.');
        }
        await guest.goto(target.pathname);
        await expect(guest.getByRole('heading', { name: tableName, exact: false })).toBeVisible();
        await guest.getByRole('combobox', { name: 'Deck', exact: true }).selectOption({ label: deckName });
        await expect(guest.getByLabel('Password', { exact: true })).toHaveCount(0);
        await guest.getByRole('button', { name: 'Take a seat' }).click();
        await guest.waitForURL('**/tables');
        await expect(hostTable.getByText('Ready to start', { exact: true })).toBeVisible();
        await expect(tableRow(guest, tableName).getByText('Ready to start', { exact: true })).toBeVisible();
        const seats = hostTable.getByRole('list', { name: 'Seats' }).getByRole('listitem');
        const exactSeats = await seats.evaluateAll((nodes, expected) =>
          nodes.length === expected.length && nodes.every((node, index) =>
            (node.getAttribute('title') ?? '').toLowerCase() === expected[index].toLowerCase()),
        [hostAccount.username, guestAccount.username]);
        expect(exactSeats, 'The host and the intended friend occupy their own seats').toBe(true);
      });

      await test.step('Both players can chat and the host starts the ready match', async () => {
        await hostTable.getByRole('button', { name: 'Table chat' }).click();
        await tableRow(guest, tableName).getByRole('button', { name: 'Table chat' }).click();
        const message = `Ready for ${tableName}`;
        await host.getByRole('textbox', { name: 'Table chat message' }).fill(message);
        await host.getByRole('region', { name: 'Table chat' }).getByRole('button', { name: 'Send' }).click();
        await expect(guest.getByRole('region', { name: 'Table chat' }).getByText(message, { exact: true })).toBeVisible();
        await hostTable.getByRole('button', { name: 'Start' }).click();
      });

      await test.step('Sideboards remain private and the second game closes the match 2–0', async () => {
        const { winner, loser } = await finishBestOfThree(host, guest);
        await expect(gameOver(winner).getByText('You won the match 2–0.')).toBeVisible();
        await expect(gameOver(loser).getByText('You lost the match 0–2.')).toBeVisible();
      });
    } finally {
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });
});
