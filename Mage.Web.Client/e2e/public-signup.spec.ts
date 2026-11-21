import { expect, test } from '@playwright/test';

const anonymous = { status: 401, json: {} };
const signupApi = '/api/playtesting/signup';
const token = 'a'.repeat(43);

test.skip(process.env.VITE_PRIVATE_PLAYTESTING !== 'true', 'Uses the private Thoughtseize build.');

test('[PUB-AC-01] public home offers signup and password sign-in', async ({ page }) => {
  await page.route('**/api/playtesting/me', (route) => route.fulfill(anonymous));
  await page.goto('/');
  const name = process.env.VITE_APP_NAME?.trim() || 'Thoughtseize';
  await expect(page).toHaveTitle(name);
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Play Magic. Get better.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', '/login');
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
});

test('[PUB-AC-02] retries a failed verification email request with the address intact', async ({ page }) => {
  await page.route(`**${signupApi}/config`, (route) => route.fulfill({ json: { turnstileSiteKey: null } }));
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

test('[PUB-AC-04] requires a fresh Turnstile token for each verification-email request', async ({ page }) => {
  await page.route(`**${signupApi}/config`, (route) => route.fulfill({ json: { turnstileSiteKey: 'fixture-public-key' } }));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `let attempt = 0;
      window.turnstile = {
        render(container, options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Solve fixture challenge';
          button.onclick = () => options.callback('fixture-challenge-' + ++attempt);
          container.append(button);
          return 'fixture';
        },
        remove() {}
      };`,
  }));
  const payloads: unknown[] = [];
  await page.route(`**${signupApi}/request`, (route) => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({ status: payloads.length === 1 ? 403 : 202, json: {} });
  });
  await page.goto('/register');
  await page.getByLabel('Email address').fill('player@example.test');
  const submit = page.getByRole('button', { name: 'Send verification link' });
  const challenge = page.getByRole('button', { name: 'Solve fixture challenge' });
  await expect(submit).toBeDisabled();
  await challenge.click();
  await submit.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(page.getByLabel('Email address')).toHaveValue('player@example.test');
  await challenge.click();
  await submit.click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(payloads).toEqual([
    { email: 'player@example.test', turnstileToken: 'fixture-challenge-1' },
    { email: 'player@example.test', turnstileToken: 'fixture-challenge-2' },
  ]);
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
  await context.route(`**${signupApi}/config`, (route) => route.fulfill({ json: { turnstileSiteKey: null } }));
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
