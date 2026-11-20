import { expect, test } from '@playwright/test';

const anonymous = { status: 401, json: {} };
const signupApi = '/api/playtesting/signup';
const token = 'a'.repeat(43);

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'Uses the Playmat product build.');

test('[PUB-AC-01] public home offers signup and password sign-in', async ({ page }) => {
  await page.route('**/api/playtesting/me', (route) => route.fulfill(anonymous));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Play Magic. Get better.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login');
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
});

test('[PUB-AC-02] retries a failed verification email request with the address intact', async ({ page }) => {
  const accepted = { status: 202, json: {} };
  let requests = 0;
  await page.route(`**${signupApi}/request`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ email: 'player@example.test' });
    await route.fulfill(++requests === 1 ? { status: 503, json: {} } : accepted);
  });
  await page.goto('/register');
  await page.getByLabel('Email address').fill('player@example.test');
  await page.getByRole('button', { name: 'Send verification link' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveValue('player@example.test');
  await page.getByRole('button', { name: 'Send verification link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
});

test('[PUB-AC-03] submits a fragment token only when the player sets a password', async ({ page }) => {
  const usernames: string[] = [];
  await page.route('**/api/playtesting/me', (route) => route.fulfill(anonymous));
  await page.route(`**${signupApi}/complete`, async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload).toEqual({ token, username: expect.any(String), password: 'Fixture password 412' });
    expect(route.request().headers().referer ?? '').not.toContain(token);
    usernames.push(payload.username);
    await route.fulfill({ status: usernames.length === 1 ? 409 : 201, json: {} });
  });
  await page.goto(`/register/complete#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Choose your player name' })).toBeVisible();
  expect(usernames).toHaveLength(0);
  await page.getByLabel('Username').fill('TakenName');
  await page.getByLabel('Password').fill('Fixture password 412');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('That username is taken');
  await page.getByLabel('Username').fill('NewName');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(usernames).toEqual(['TakenName', 'NewName']);
});

test('[PUB-AC-03] missing or expired links can be replaced', async ({ page }) => {
  await page.goto('/register/complete');
  await expect(page.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/register');
  await page.route(`**${signupApi}/complete`, (route) => route.fulfill({ status: 410, json: {} }));
  await page.goto(`/register/complete#token=${token}`);
  await page.getByLabel('Username').fill('FreshFixture');
  await page.getByLabel('Password').fill('Fixture password 412');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
});

test('[PUB-AC-03] signup from a match invitation preserves the match across tabs', async ({ page, context }) => {
  const match = '/join/1f4d5e7e-f669-4b0a-944f-eab1a563ce3e';
  await context.route(`**${signupApi}/request`, (route) => route.fulfill({ status: 202, json: {} }));
  await context.route(`**${signupApi}/complete`, (route) => route.fulfill({ status: 201, json: {} }));
  // Keep the auth transition observable without a live engine.
  await context.route('**/api/playtesting/me', (route) => route.fulfill({ status: 500, json: {} }));
  await page.goto(`/register?next=${encodeURIComponent(match)}`);
  await page.getByLabel('Email address').fill('player@example.test');
  await page.getByRole('button', { name: 'Send verification link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const emailTab = await context.newPage();
  await emailTab.goto(`/register/complete#token=${token}`);
  await emailTab.getByLabel('Username').fill('FreshFixture');
  await emailTab.getByLabel('Password').fill('Fixture password 412');
  await emailTab.getByRole('button', { name: 'Create account' }).click();
  await expect(emailTab).toHaveURL(new RegExp(`${match}$`));
});
