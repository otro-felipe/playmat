import { expect, type Page } from '@playwright/test';
import { decisionCluster, gameOver, keepOpeningHand } from './app';

export const sideboardDeck = '60 Plains\n\nSideboard\n15 Island';

/** Takes an already started match through sideboarding and to a 2–0 result. */
export async function finishBestOfThree(host: Page, guest: Page) {
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
  return { winner, loser };
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
