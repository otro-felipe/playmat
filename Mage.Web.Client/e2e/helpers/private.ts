import type { Locator, Page } from '@playwright/test';

type Account = { username: string; password: string };

export function qaAccount(seat: 'A' | 'B'): Account {
  const username = process.env[`PLAYMAT_PRIVATE_QA_${seat}_USERNAME`];
  const password = process.env[`PLAYMAT_PRIVATE_QA_${seat}_PASSWORD`];
  if (!username || !password) throw new Error(`Provisioned QA seat ${seat} is missing its credentials.`);
  return { username, password };
}

// Use the DOM setter so React receives the input event and Playwright action titles omit the value.
export async function setPrivateInput(locator: Locator, value: string) {
  await locator.evaluate((input, text) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setValue || !(input instanceof HTMLInputElement)) throw new Error('Expected a text input.');
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

export async function signInPrivate(page: Page, account: Account) {
  await page.goto('/decks');
  const password = page.locator('input[autocomplete="current-password"]');
  await password.waitFor();
  await setPrivateInput(page.locator('input[autocomplete="username"]'), account.username);
  await setPrivateInput(password, account.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/decks', { timeout: 30_000 });
}

export async function addPrivateFriend(page: Page, friend: string) {
  await page.getByRole('button', { name: /^Lobby:/ }).click();
  await page.getByRole('tab', { name: 'Players', exact: false }).click();
  await page.getByRole('button', { name: `Actions for ${friend}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add friend', exact: true }).click();
  await page.getByRole('button', { name: 'Close lobby', exact: true }).click();
}

export const tableRow = (page: Page, name: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: false }) });
